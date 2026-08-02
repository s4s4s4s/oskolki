// Запись в вальт: быстрая мысль, создание заметок по шаблонам, правка разделов.
//
// Все записи идут через vault_* инструменты воркера — файл целиком клиент не гоняет.
// Формат совпадает с тем, как в вальт пишут скиллы и ночные задачи: дневная заметка
// `daily/ГГГГ-ММ-ДД.md`, мысль строкой `- **ЧЧ:ММ** текст` под разделом «Мысли»,
// новые заметки — из `templates/*.md` с подстановкой {{date}} и {{title}}.
import { tools, ToolError, NetError } from './api.js';
import { DAILY_DIR, DAILY_THOUGHTS } from './config.js';
import { queuePush, queueAll, queueDrop, queueCount } from './store.js';
import { addTag, removeTag, addLink, removeLink, setField } from './frontmatter.js';
import { forgetText } from './map.js';

export const ymd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export const dailyPath = (d = new Date()) => `${DAILY_DIR}/${ymd(d)}.md`;

// Воркер сообщает об отсутствующем заголовке двумя разными фразами: vault_section
// говорит «Заголовка «X» нет», vault_patch — «Заголовок «X» не найден». Ловим обе,
// иначе мысль в файл без раздела «Мысли» просто не запишется.
const NO_FILE = /нет файла|Файла .* нет/i;
const NO_HEADING = /Заголов(?:ок|ка) «|не найден/i;

// Шаблоны вальта. Читаем настоящие файлы: там формат фронтматтера, разделы и
// wikilinks в том виде, в каком их ждут Obsidian и ночная консолидация.
export const TEMPLATES = [
  { file: 'templates/Заметка.md', label: 'ЗАМЕТКА', zone: 'brain' },
  { file: 'templates/Проект.md', label: 'ПРОЕКТ', zone: 'projects' },
  { file: 'templates/Человек.md', label: 'ЧЕЛОВЕК', zone: 'people' },
  { file: 'templates/Решение.md', label: 'РЕШЕНИЕ', zone: 'brain/decisions' },
];

const tplCache = new Map();
export async function readTemplate(file) {
  if (tplCache.has(file)) return tplCache.get(file);
  const text = await tools.read(file);
  tplCache.set(file, text);
  return text;
}

export const fillTemplate = (tpl, { title = '', date = ymd() } = {}) =>
  tpl.replace(/\{\{date\}\}/g, date).replace(/\{\{title\}\}/g, title);

// Встроенный запасной шаблон дня: если templates/Daily.md недоступен, мысль всё
// равно должна записаться — терять её из-за отсутствия шаблона нельзя.
const FALLBACK_DAILY = date => `---
type: daily
status: active
created: ${date}
description: "Дневная заметка ${date}"
tags: [daily]
---

# ${date}

## События

## ${DAILY_THOUGHTS}
`;

async function dailyTemplate(date) {
  try {
    const tpl = await readTemplate('templates/Daily.md');
    return fillTemplate(tpl, { date });
  } catch {
    return FALLBACK_DAILY(date);
  }
}

// Вставка строки в конец раздела при создании файла (сервером пока не через что).
function insertUnder(text, heading, line) {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l.replace(/ /g, ' ').trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (at === -1) return `${text.replace(/\s+$/, '')}\n\n## ${heading}\n\n${line}\n`;
  let end = at + 1;
  while (end < lines.length && !/^#{1,6} /.test(lines[end])) end++;
  while (end > at + 1 && lines[end - 1].trim() === '') end--;
  lines.splice(end, 0, '', line);
  return lines.join('\n').replace(/\s+$/, '') + '\n';
}

/* ── очередь на случай обрыва связи ──────────────────────────────────────────
   В очередь кладётся ЛОГИЧЕСКАЯ операция, а не конкретный вызов инструмента:
   офлайн неизвестно, существует ли уже дневной файл, и выбирать между patch и
   create придётся заново — в момент отправки. */
const queueable = async (kind, payload, run) => {
  try { return await run(); }
  catch (e) {
    if (!(e instanceof NetError)) throw e;
    await queuePush({ kind, payload });
    return { queued: true, kind };
  }
};

export const pendingWrites = () => queueCount();

// Досылка. Порядок сохраняется: записи уходят так же, как набирались.
// Сетевая ошибка обрывает досылку (связь снова пропала), содержательная —
// снимает запись с очереди, иначе она будет вечно стучаться в стену.
export async function flushQueue({ onSent, onFailed } = {}) {
  const items = await queueAll();
  let sent = 0;
  for (const it of items) {
    try {
      await runQueued(it);
      await queueDrop(it.id);
      sent++; onSent && onSent(it);
    } catch (e) {
      if (e instanceof NetError) break;
      await queueDrop(it.id);
      onFailed && onFailed(it, e);
    }
  }
  return { sent, left: await queueCount() };
}

function runQueued(it) {
  const p = it.payload;
  switch (it.kind) {
    case 'thought': return writeThought(p.text, new Date(p.when));
    case 'note': return writeNote(p);
    case 'section': return addSection(p.path, p.heading, p.content);
    case 'patch': return patchSection(p.path, p.heading, p.content, p.operation);
    case 'field': {
      const ops = {
        addTag: t => addTag(t, p.arg), removeTag: t => removeTag(t, p.arg),
        setField: t => setField(t, p.arg[0], p.arg[1]),
        addLink: t => addLink(t, p.arg[0], p.arg[1]), removeLink: t => removeLink(t, p.arg[0], p.arg[1]),
      };
      if (!ops[p.op]) throw new ToolError(`неизвестная правка: ${p.op}`);
      return editNoteFile(p.path, ops[p.op], `${p.op}: ${p.path}`);
    }
    default: throw new ToolError(`неизвестная запись в очереди: ${it.kind}`);
  }
}

/* ── быстрая мысль ────────────────────────────────────────────────────────── */

// Три ветки, потому что три реальных состояния дня: файла нет, файл есть без
// раздела «Мысли», файл есть с разделом. Ни одна не должна терять текст.
async function writeThought(text, when) {
  const path = dailyPath(when);
  const line = `- **${hm(when)}** ${text.trim()}`;
  try {
    const answer = await tools.patch(path, DAILY_THOUGHTS, line, 'append', `мысль: ${path}`);
    return { path, answer, mode: 'patch' };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    if (NO_FILE.test(e.message)) {
      const body = insertUnder(await dailyTemplate(ymd(when)), DAILY_THOUGHTS, line);
      return { path, answer: await tools.create(path, body), mode: 'create' };
    }
    if (NO_HEADING.test(e.message)) {
      const answer = await tools.append(path, `## ${DAILY_THOUGHTS}\n\n${line}`);
      return { path, answer, mode: 'append' };
    }
    throw e;
  }
}

export const appendThought = (text, when = new Date()) =>
  queueable('thought', { text, when: when.toISOString() }, () => writeThought(text, when))
    .then(r => ({ path: dailyPath(when), ...r }));

/* ── создание заметки ─────────────────────────────────────────────────────── */

// Имя файла из заголовка: вальт хранит заметки под человеческими именами
// («Система памяти — обзор.md»), по ним же резолвятся [[wikilinks]].
export const safeFileName = title => title.trim().replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();

// Первый текст ставится под заголовком файла, ДО первого раздела шаблона.
// Иначе он падает в самый низ, под «## Связи», и заметка начинается с пустоты.
function putIntro(text, intro) {
  const lines = text.split('\n');
  const h1 = lines.findIndex(l => /^# /.test(l));
  if (h1 === -1) return `${intro.trim()}\n\n${text}`;
  let at = h1 + 1;
  while (at < lines.length && !/^#{2,6} /.test(lines[at])) at++;
  while (at > h1 + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, '', intro.trim());
  return lines.join('\n');
}

async function writeNote({ title, zone, template, description = '', body = '' }) {
  const name = safeFileName(title);
  if (!name) throw new Error('нужно имя заметки');
  const path = `${zone ? zone.replace(/\/$/, '') + '/' : ''}${name}.md`;
  let text = template ? fillTemplate(await readTemplate(template), { title: name }) : `# ${name}\n`;
  if (description) text = text.replace(/^description:\s*""\s*$/m, `description: "${description.replace(/"/g, "'")}"`);
  if (body.trim()) text = putIntro(text, body);
  const answer = await tools.create(path, text.replace(/\s+$/, '') + '\n');
  return { path, answer };
}

export const createNote = opts =>
  queueable('note', opts, () => writeNote(opts))
    .then(r => ({ path: `${opts.zone ? opts.zone.replace(/\/$/, '') + '/' : ''}${safeFileName(opts.title)}.md`, ...r }));

/* ── свойства заметки: теги, тип, статус, типизированные связи ───────────────
   Всё это живёт во фронтматтере, то есть выше любого заголовка, — значит
   правится только перезаписью файла целиком (vault_write). Читаем свежую
   версию прямо перед записью: между открытием заметки и нажатием на тег могли
   пройти часы. */
async function editNoteFile(path, transform, message) {
  const text = await tools.read(path);
  const next = transform(text);
  if (next === text) return { path, answer: 'без изменений', changed: false };
  const answer = await tools.write(path, next, message);
  forgetText(path);
  return { path, answer, changed: true };
}

export const toggleTag = (path, tag, on) =>
  queueable('field', { path, op: on ? 'addTag' : 'removeTag', arg: tag }, () =>
    editNoteFile(path, t => (on ? addTag : removeTag)(t, tag), `${on ? 'тег' : 'снят тег'}: ${tag}`));

export const setNoteField = (path, key, value) =>
  queueable('field', { path, op: 'setField', arg: [key, value] }, () =>
    editNoteFile(path, t => setField(t, key, value), `${key}: ${value || '—'}`));

// Связь ставится с одной стороны: обратную сторону приложение и так показывает
// как «на это ссылаются». Дублировать её в файле — плодить рассинхрон.
export const linkTo = (path, field, target) =>
  queueable('field', { path, op: 'addLink', arg: [field, target] }, () =>
    editNoteFile(path, t => addLink(t, field, target), `связь ${field}: ${target}`));

export const unlinkFrom = (path, field, target) =>
  queueable('field', { path, op: 'removeLink', arg: [field, target] }, () =>
    editNoteFile(path, t => removeLink(t, field, target), `снята связь ${field}: ${target}`));

/* Массовое переименование тега по всему вальту. На десяти тысячах заметок
   теги без этого превращаются в свалку: «ереван», «Ереван» и «переезд/ереван»
   живут порознь, и ни один фильтр не показывает всё сразу. */
export async function renameTag(paths, from, to, onStep) {
  let done = 0, changed = 0;
  for (const path of paths) {
    onStep && onStep(++done, paths.length, path);
    const r = await editNoteFile(path, t => {
      const stripped = removeTag(t, from);
      return to ? addTag(stripped, to) : stripped;
    }, to ? `тег ${from} → ${to}` : `снят тег ${from}`);
    if (r.changed) changed++;
  }
  return { done, changed };
}

/* ── разделы ──────────────────────────────────────────────────────────────── */

/* Утверждение из приложения. Тот же формат, что пишет воркер инструментом
   vault_claim, и та же проверка: без якоря не записываем, потому что осколок без
   сущности не найдётся никогда — его не за что зацепить.

   Имя режется по границе слова: оно попадает в списки, и обрывок посреди слова
   обесценивает утверждение, ради которого файл и заводили. */
export async function saveClaim({ text, тип = 'факт', о, когда = ymd(), уверенность = 'высокая' }) {
  const тело = String(text).replace(/\s+/g, ' ').trim();
  if (тело.length < 12) throw new Error('слишком коротко для утверждения');
  if (!о) throw new Error('нужна сущность, к которой крепится утверждение');
  const чистый = тело.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const слаг = (чистый.length <= 80 ? чистый : чистый.slice(0, 80).replace(/\s+\S*$/, '')).replace(/[.,;:]+$/, '');
  const path = `осколки/${когда} ${слаг}.md`;
  const fm = [
    '---',
    'класс: утверждение',
    `тип: ${тип}`,
    `когда: ${когда}`,
    'статус: актуально',
    `о: ["[[${о}]]"]`,
    `источник: "приложение ${когда}"`,
    `уверенность: ${уверенность}`,
    '---',
  ].join('\n');
  await tools.create(path, `${fm}\n\n${тело}\n`);
  return path;
}

export const patchSection = (path, heading, content, operation = 'replace') =>
  tools.patch(path, heading, content, operation, `${operation}: ${path}`);

// Новый раздел дописывается в конец файла: vault_patch умеет писать только под
// существующий заголовок, а создавать разделы приложению нужно.
export const addSection = (path, heading, content = '') =>
  tools.append(path, `## ${heading}\n\n${content.trim()}`);
