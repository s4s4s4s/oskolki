// Демо-режим: тот же интерфейс инструментов, что у vault-mcp, но в памяти.
// Позволяет смотреть и разрабатывать интерфейс без секрета.
import { INDEX_DIR } from './config.js';

const now = Date.now();
const D = 864e5, H = 36e5;
const iso = t => new Date(t).toISOString();

// Структура повторяет настоящий вальт (daily, brain, brain/log, people,
// projects, resources, _tools/queue) — иначе демо показывает не ту логику
// созвездий, что боевое приложение. Содержимое вымышленное: страница публична.
const FILES = {
'daily/2026-08-02.md': `---\ntype: daily\nstatus: active\ncreated: 2026-08-02\ntags: [daily]\n---\n\n# 2026-08-02\n\n## События\n\n- Разобрал утренние заметки, свёл три черновика в [[Карта памяти — обзор]].\n\n## Мысли\n\n- **10:12** свежесть заметки важнее её длины — проверить на [[hot]]\n`,
'daily/2026-08-01.md': `---\ntype: daily\nstatus: active\ncreated: 2026-08-01\ntags: [daily]\n---\n\n# 2026-08-01\n\n## События\n\n- Разговор с [[Наставник|наставником]] про медленное чтение — вынес в [[Кладовая цитат]].\n\n## Мысли\n\n- **21:40** вечерний разбор занимает семь минут, если не растекаться\n`,
'brain/hot.md': `---\ntype: note\nstatus: active\ntags: [brain]\n---\n\n# Hot\n\n## Сейчас\n\n- Довести [[Демо-приложение памяти]] до состояния «показать».\n- Перечитать [[Карта памяти — обзор]] и вычистить дубли.\n\n## Ждёт ответа\n\n- Письмо в архив цитат — см. [[Кладовая цитат]].\n`,
'brain/index.md': `---\ntype: note\nstatus: active\ntags: [brain]\n---\n\n# Индекс памяти\n\n## Ключевые решения\n\n- Память живёт в обычных markdown-файлах — никаких баз данных. См. [[Карта памяти — обзор]].\n- Журналы отделены от заметок: журнал упоминает, заметка утверждает.\n\n## Точки входа\n\n[[hot]] · [[Карта памяти — обзор]] · [[Демо-приложение памяти]]\n`,
'brain/Карта памяти — обзор.md': `---\ntype: note\nstatus: active\ncreated: 2026-05-14\ntags: [метод, память]\n---\n\n# Карта памяти — обзор\n\n## Суть\n\nЗаметки не хранятся — растут. Осколок становится картой, когда к нему возвращаешься. Свежесть правки — не украшение, а сигнал: что живо, а что пора переписать.\n\n## Практика возвращения\n\nРаз в неделю открывать три случайные заметки старше месяца. Одну переписать заново сегодняшними словами, ссылку на старую оставить.\n\n## Связи\n\n[[hot]] · [[index]] · [[Демо-приложение памяти]]\n`,
'brain/Медленное чтение.md': `---\ntype: note\nstatus: active\ntags: [чтение]\n---\n\n# Медленное чтение\n\n## Ходы\n\nПеречитывание — та же пересадка: старый текст в новую почву сегодняшнего дня. Источник: [[Кладовая цитат]].\n`,
'brain/log/2026-08-02-chat.md': `---\ntype: log\ntags: [log]\n---\n\n# Лог 2026-08-02 (chat)\n\n## Записи\n\n- [10:20] Обсудили разбиение созвездий: журнал отделяется от заметок, вес источника 0.4.\n- [11:05] Решено: поиск в приложении повторяет серверный код, а не пишется заново.\n`,
'brain/log/2026-08-01-chat.md': `---\ntype: log\ntags: [log]\n---\n\n# Лог 2026-08-01 (chat)\n\n## Записи\n\n- [18:30] Перебрали формат дневной заметки: События / Мысли / Связи.\n- [19:15] Быстрая мысль пишется строкой «- **ЧЧ:ММ** текст» под «Мысли».\n`,
'brain/log/2026-07-31-nightly.md': `---\ntype: log\ntags: [log]\n---\n\n# Лог 2026-07-31 (nightly)\n\n## Записи\n\n- Ночная сводка: собрано 4 новые заметки, дублей нет.\n`,
'people/Наставник.md': `---\ntype: person\nstatus: active\ntags: [person]\n---\n\n# Наставник\n\n## Кто и связи\n\nСтарший коллега, с которым сверяю подход к записям.\n\n## Темы для разговора\n\n«Записывай не выводы, а живые осколки — карта вырастет сама». Отсюда [[Карта памяти — обзор]].\n`,
'people/Соседка по этажу.md': `---\ntype: person\nstatus: active\ntags: [person]\n---\n\n# Соседка по этажу\n\n## Контакты\n\n- Мессенджеры: только вечером\n\n## История\n\n- 2026-07-20 — поливала цветы, пока меня не было.\n`,
'projects/Демо-приложение памяти.md': `---\ntype: project\nstatus: active\ntags: [проект, код]\n---\n\n# Демо-приложение памяти\n\n## Цель\n\nКарта памяти поверх вальта: граф связей, картотека, правка разделов, живой синхрон, разговор с ИИ по собственным заметкам.\n\n## Текущий статус\n\nГраф, поиск и запись работают. Это демо-режим: данные вымышленные.\n\n## Следующие шаги\n\n- [ ] офлайн-копия корпуса\n- [ ] локальные шрифты\n\n## Связи\n\n[[Карта памяти — обзор]] · [[hot]]\n`,
'projects/Тренажёр слов.md': `---\ntype: project\nstatus: active\ntags: [проект]\n---\n\n# Тренажёр слов\n\n## Цель\n\nИнтервальные повторения без сторонних приложений: карточки лежат в тех же markdown-файлах.\n\n## Связи\n\n[[Демо-приложение памяти]]\n`,
'resources/Кладовая цитат.md': `---\ntype: note\nstatus: active\ntags: [цитаты]\n---\n\n# Кладовая цитат\n\n## Про память\n\n> Мы — то, к чему возвращаемся.\n\n## Про чтение\n\nСм. [[Медленное чтение]].\n`,
'resources/Ритуал разбора дня.md': `---\ntype: note\nstatus: active\ntags: [ритуал]\n---\n\n# Ритуал разбора дня\n\n## Порядок\n\n1. Что двигало вперёд\n2. Что тянуло назад\n3. Одна заметка на переписывание — см. [[Карта памяти — обзор]]\n`,
'areas/Здоровье.md': `---\ntype: note\nstatus: active\ntags: [areas]\n---\n\n# Здоровье\n\n## Правила\n\n- экран гаснет в 23:00\n- подъём без будильника — цель, не догма\n`,
'_tools/queue/2026-08-01-собрать-индекс.md': `---\ntype: task\ntags: [queue]\n---\n\n# Собрать индекс\n\n## Задание\n\nПересобрать индекс заметок и проверить, что метаданные заполнены.\n`,
'_tools/queue/2026-07-30-проверить-ссылки.md': `---\ntype: task\ntags: [queue]\n---\n\n# Проверить ссылки\n\n## Задание\n\nНайти битые [[wikilinks]] и свести их в список.\n`,
};

// метаданные: возраст правки в часах
const AGES = {
'daily/2026-08-02.md': .2, 'daily/2026-08-01.md': 26,
'brain/hot.md': 3, 'brain/index.md': 40, 'brain/Карта памяти — обзор.md': 49, 'brain/Медленное чтение.md': 190,
'brain/log/2026-08-02-chat.md': 6, 'brain/log/2026-08-01-chat.md': 30, 'brain/log/2026-07-31-nightly.md': 54,
'people/Наставник.md': 96, 'people/Соседка по этажу.md': 300,
'projects/Демо-приложение памяти.md': 20, 'projects/Тренажёр слов.md': 290,
'resources/Кладовая цитат.md': 140, 'resources/Ритуал разбора дня.md': 210,
'areas/Здоровье.md': 100,
'_tools/queue/2026-08-01-собрать-индекс.md': 34, '_tools/queue/2026-07-30-проверить-ссылки.md': 80,
};
// Шаблоны читаются приложением, но в индекс не попадают — как в настоящем
// вальте, где `templates/` исключён сборщиком. Иначе они всплыли бы на карте
// как заметки.
const TEMPLATE_FILES = {
  'templates/Daily.md': `---\ntype: daily\nstatus: active\ncreated: {{date}}\ndescription: "Дневная заметка"\ntags: []\n---\n\n# {{date}}\n\n## События\n\n## Мысли\n`,
  'templates/Заметка.md': `---\ntype: note\nstatus: active\ncreated: {{date}}\ndescription: ""\ntags: []\n---\n\n# {{title}}\n\n## Связи\n`,
  'templates/Проект.md': `---\ntype: project\nstatus: active\ncreated: {{date}}\ndescription: ""\ntags: []\n---\n\n# {{title}}\n\n## Цель\n\n## Текущий статус\n\n## Следующие шаги\n\n## Связи\n`,
  'templates/Человек.md': `---\ntype: person\nstatus: active\ncreated: {{date}}\ndescription: ""\ntags: [person]\n---\n\n# {{title}}\n\n## Кто и связи\n\n## Контакты\n\n## Связи\n`,
  'templates/Решение.md': `---\ntype: decision\nstatus: active\ncreated: {{date}}\ndescription: ""\ntags: []\n---\n\n# {{title}}\n\n## Решение\n\n## Почему\n\n## Связи\n`,
};

const enc = new TextEncoder();
const bytes = s => enc.encode(s).length;
const meta = () => {
  const m = {};
  for (const p of Object.keys(FILES)) {
    const h = now - (AGES[p] || 200) * H;
    m[p] = { u: iso(h + 4 * H > now ? h : h + 4 * H), h: iso(h), c: 3 + (bytes(FILES[p]) % 40), b: bytes(FILES[p]) };
  }
  return m;
};

// куски индекса: по разделам, как строит сервер
function chunks() {
  const out = [];
  for (const [p, raw] of Object.entries(FILES)) {
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
    const parts = body.split(/(?=^#{1,4} )/m).filter(s => s.trim());
    let chain = [];
    parts.forEach((part, i) => {
      const m2 = part.match(/^(#{1,4}) (.+)\n?/);
      if (m2) chain = m2[1].length === 2 ? [m2[2].trim()] : [...chain.slice(0, 1), m2[2].trim()];
      out.push({ p, h: [...chain], t: part.replace(/^#{1,4} .+\n/, '').trim(), i });
    });
  }
  return out;
}

const sectionsOf = raw => {
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  return body.split(/(?=^## )/m).map(s => ({ h: (s.match(/^## (.+)/) || [])[1] || null, body: s }));
};

let commit = 4096;
const ok = text => ({ content: [{ text }], isError: false });
const err = text => ({ content: [{ text }], isError: true });

export const demoTransport = {
  demo: true,
  async ping() { await pause(120); return {}; },
  async call(name, a = {}) {
    await pause(90 + Math.random() * 160);
    switch (name) {
      case 'vault_list': {
        const path = (a.path || '').replace(/\/$/, '');
        if (path === INDEX_DIR) return ok(`${INDEX_DIR}/00.json (48211 б)\n${INDEX_DIR}/meta.json (2412 б)`);
        const seen = new Set(); const lines = [];
        for (const p of Object.keys(FILES)) {
          if (path && !p.startsWith(path + '/')) continue;
          const rest = path ? p.slice(path.length + 1) : p;
          const top = rest.split('/')[0];
          if (rest.includes('/')) { if (!seen.has(top)) { seen.add(top); lines.push(`[папка] ${top}`); } }
          else lines.push(`${p} (${bytes(FILES[p])} б)`);
        }
        return ok(lines.join('\n') || 'пусто');
      }
      case 'vault_read': {
        if (a.path === `${INDEX_DIR}/meta.json`) return ok(JSON.stringify(meta()));
        if (a.path === `${INDEX_DIR}/00.json`) return ok(JSON.stringify(chunks()));
        if (TEMPLATE_FILES[a.path] != null) return ok(TEMPLATE_FILES[a.path]);
        return FILES[a.path] != null ? ok(FILES[a.path]) : err(`Файла ${a.path} нет`);
      }
      case 'vault_search': {
        const q = (a.query || '').toLowerCase(); const lim = a.limit || 20; const blocks = [];
        for (const [p, raw] of Object.entries(FILES)) for (const s of sectionsOf(raw)) {
          const idx = s.body.toLowerCase().indexOf(q);
          if (q && idx >= 0 && blocks.length < lim) {
            const frag = s.body.replace(/^#{1,4} .+\n/, '').replace(/\n+/g, ' ').trim();
            const at = Math.max(0, frag.toLowerCase().indexOf(q) - 60);
            blocks.push(`**${p}**${s.h ? ' › ' + s.h : ''}\n${(at ? '…' : '') + frag.slice(at, at + 160)}…`);
          }
        }
        return ok(blocks.join('\n\n') + `\n\nпоказаны первые ${blocks.length} блоков — уточните запрос или поднимите limit`);
      }
      case 'vault_patch': {
        // тексты ошибок повторяют воркер: приложение разбирает их регулярками
        const raw = FILES[a.path]; if (raw == null) return err(`Файла ${a.path} нет. Создай через vault_create.`);
        const re = new RegExp(`(^#{1,4} ${escapeRe(a.heading)}\\s*\\n)([\\s\\S]*?)(?=^#{1,4} |$(?![\\s\\S]))`, 'm');
        if (!re.test(raw)) return err(`Заголовок «${a.heading}» не найден.`);
        FILES[a.path] = raw.replace(re, (_, hd, body) =>
          a.operation === 'append' ? hd + body.replace(/\s*$/, '\n') + a.content + '\n\n'
          : a.operation === 'prepend' ? hd + a.content + '\n\n' + body
          : hd + '\n' + a.content + '\n\n');
        AGES[a.path] = 0; commit++;
        emit({ type: 'push', sha: sha(), message: `patch: ${a.path}`, paths: [a.path], indexTouched: false });
        return ok(`закоммичено ${sha()} — ${a.path}`);
      }
      case 'vault_append': {
        FILES[a.path] = (FILES[a.path] || '') + (FILES[a.path] ? '\n' : '') + a.content + '\n';
        AGES[a.path] = 0; commit++;
        emit({ type: 'push', sha: sha(), message: `append: ${a.path}`, paths: [a.path], indexTouched: false });
        return ok(`закоммичено ${sha()} — ${a.path}`);
      }
      case 'vault_create': {
        if (FILES[a.path] != null) return err(`${a.path} уже существует. Используй vault_patch или vault_append.`);
        FILES[a.path] = a.content; AGES[a.path] = 0; commit++;
        return ok(`Создан ${a.path}. Коммит ${sha()}.`);
      }
      case 'vault_write': {
        const was = FILES[a.path];
        if (was == null) return err(`Файла ${a.path} нет. Создай через vault_create.`);
        FILES[a.path] = a.content; AGES[a.path] = 0; commit++;
        emit({ type: 'push', sha: sha(), message: `write: ${a.path}`, paths: [a.path], indexTouched: false });
        return ok(`Перезаписан ${a.path}. Коммит ${sha()}. Было ${was.length} символов, стало ${a.content.length}.`);
      }
      default: return err(`неизвестный инструмент ${name}`);
    }
  },
};
const sha = () => commit.toString(16).padStart(6, '0');
const pause = ms => new Promise(r => setTimeout(r, ms));
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// фальшивый живой канал
let listeners = [];
function emit(ev) { setTimeout(() => listeners.forEach(l => l.onEvent && l.onEvent(ev)), 1200); }
export function demoChannel() {
  const ch = {
    onEvent: null, onStatus: null,
    start() { listeners.push(ch); setTimeout(() => ch.onStatus && ch.onStatus('live'), 600); },
    stop() { listeners = listeners.filter(l => l !== ch); },
  };
  return ch;
}
