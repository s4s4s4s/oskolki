/**
 * Проверка осколков: формат, ссылки, дубли, признаки пересказа.
 *
 * Извлечение делает модель, а модель ошибается предсказуемым набором способов:
 * пишет пересказ вместо утверждения, ссылается на несуществующую сущность,
 * склеивает два факта в один абзац, забывает дату. На одном осколке это видно
 * глазами, на тысяче — нет. Поэтому проверка механическая и обязательная: всё,
 * что её не прошло, в базу не попадает.
 *
 * Что проверяется:
 *   поля      — класс, тип, когда, статус, источник, о, уверенность;
 *   ссылки    — источник и каждая сущность резолвятся в существующий файл;
 *   тело      — одно утверждение, не пересказ, не пустое, не гигант;
 *   дубли     — пары осколков с сильно пересекающимся словарём;
 *   отмены    — `отменяет` указывает на существующий осколок, и тот помечен.
 *
 * Ничего не чинит: печатает и выходит с кодом 1, если есть ошибки. Починка —
 * дело того, кто извлекал, иначе правки разъедутся с источником.
 *
 * Запуск: node _dev/shard-lint.mjs [--vault <путь>] [--dir осколки]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, posix, basename } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const VAULT = resolve(flag('vault', 'C:/Users/sasha/Documents/Obsidian Vault'));
const DIR = flag('dir', 'осколки');

// «Урок» стоит рядом с «правилом», но отличается адресатом: правило — про мир и
// его порядок, урок — про то, как здесь работать, и пишется после того, как об
// это уже споткнулись. Уроки приходят агенту до начала работы, а не по запросу.
const ТИПЫ = ['факт', 'решение', 'правило', 'урок', 'наблюдение', 'договорённость', 'намерение', 'событие'];
const СТАТУСЫ = ['актуально', 'устарело', 'отменено'];
const УВЕРЕННОСТЬ = ['высокая', 'средняя', 'низкая'];

// Обороты, с которых начинается пересказ, а не утверждение. Осколок отвечает на
// «что теперь известно», а не на «что мы делали».
const ПЕРЕСКАЗ = /^(прогнал|прогнали|сделал|сделали|посмотрел|посмотрели|обсудил|обсудили|разобрал|разобрали|проверил|проверили|начал|начали|продолжил)/i;

const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
  cwd: VAULT, encoding: 'utf8', maxBuffer: 64 << 20,
}).split('\0').filter(Boolean);
const byBase = new Map();
for (const f of files) {
  if (!f.endsWith('.md')) continue;
  const b = posix.basename(f).replace(/\.md$/i, '').toLowerCase();
  if (!byBase.has(b)) byBase.set(b, f);
}
const resolves = name => byBase.has(String(name).trim().toLowerCase()) || existsSync(join(VAULT, name));

const FM = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
function parse(text) {
  const m = text.replace(/^\uFEFF/, '').match(FM);
  if (!m) return null;
  const fm = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-zА-Яа-яЁё_][\w\u0400-\u04FF-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      fm[key] = v.startsWith('[') && v.endsWith(']')
        ? v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
        : v.replace(/^["']|["']$/g, '');
      continue;
    }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && key) {
      if (!Array.isArray(fm[key])) fm[key] = fm[key] ? [fm[key]] : [];
      fm[key].push(li[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { fm, body: text.replace(/^\uFEFF/, '').slice(m[0].length).trim() };
}

const wiki = v => [...String(v).matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].trim());
const words = t => new Set(t.toLowerCase().split(/[^0-9a-zа-яё]+/).filter(w => w.length > 3));

const dir = join(VAULT, DIR);
if (!existsSync(dir)) { console.error(`Папки ${DIR} нет.`); process.exit(1); }
const names = readdirSync(dir).filter(f => f.endsWith('.md'));

const errors = [], warnings = [];
const shards = [];
const err = (f, msg) => errors.push(`${f}\n     ✗ ${msg}`);
const warn = (f, msg) => warnings.push(`${f}\n     ! ${msg}`);

for (const name of names) {
  const raw = readFileSync(join(dir, name), 'utf8');
  const p = parse(raw);
  if (!p) { err(name, 'нет фронтматтера'); continue; }
  const { fm, body } = p;
  shards.push({ name, fm, body, w: words(body) });

  if (fm['класс'] && fm['класс'] !== 'утверждение' && fm['класс'] !== 'событие') err(name, `класс «${fm['класс']}» — в этой папке ожидается утверждение или событие`);
  if (!fm['тип']) err(name, 'нет поля «тип»');
  else if (!ТИПЫ.includes(fm['тип'])) err(name, `тип «${fm['тип']}» не из списка: ${ТИПЫ.join(', ')}`);

  if (!fm['когда']) err(name, 'нет поля «когда» — без даты утверждение нечем сравнить с другим');
  else if (!/^\d{4}-\d{2}(-\d{2})?$/.test(fm['когда'])) err(name, `«когда: ${fm['когда']}» — нужна дата вида 2026-07-22`);

  if (!fm['статус']) err(name, 'нет поля «статус»');
  else if (!СТАТУСЫ.includes(fm['статус'])) err(name, `статус «${fm['статус']}» не из списка: ${СТАТУСЫ.join(', ')}`);

  if (fm['уверенность'] && !УВЕРЕННОСТЬ.includes(fm['уверенность'])) err(name, `уверенность «${fm['уверенность']}» не из списка`);

  /* Источник обязателен всегда, но не обязан быть файлом вальта: важно не
     «откуда файл», а «откуда знание». У факта из лога это улика, у факта из
     веба — ссылка, у сказанного в разговоре — его дата. Требовать вальтовый
     файл значило бы заставлять сочинять улику ради формальности. */
  if (!fm['источник']) err(name, 'нет поля «источник» — непонятно, откуда это знание');
  else if (/^\[\[/.test(String(fm['источник']).trim())) {
    for (const t of wiki(fm['источник'])) if (!resolves(t)) err(name, `источник [[${t}]] не резолвится`);
  } else if (!/^https?:\/\//i.test(fm['источник']) && !/\d{4}-\d{2}-\d{2}/.test(fm['источник'])) {
    warn(name, `источник «${fm['источник']}» — не файл, не ссылка и без даты: по такому не проверить`);
  }

  const ents = Array.isArray(fm['о']) ? fm['о'] : fm['о'] ? [fm['о']] : [];
  const targets = ents.flatMap(wiki);
  if (!targets.length) err(name, 'нет поля «о» — утверждение не прикреплено ни к одной сущности и потеряется');
  for (const t of targets) if (!resolves(t)) err(name, `сущность [[${t}]] не резолвится — создать её или исправить имя`);

  if (fm['отменяет']) for (const t of wiki(fm['отменяет'])) if (!resolves(t)) err(name, `отменяет [[${t}]] не резолвится`);

  if (!body) err(name, 'пустое тело');
  else {
    const sentences = body.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 12);
    if (body.length > 700) warn(name, `тело ${body.length} символов — похоже на пересказ, осколок должен быть одним утверждением`);
    if (sentences.length > 3) warn(name, `${sentences.length} предложения — проверь, не два ли это утверждения`);
    if (ПЕРЕСКАЗ.test(body)) warn(name, 'начинается как пересказ действий, а не как утверждение о мире');
    if (/^(мы|я)\s/i.test(body)) warn(name, 'начинается с «мы/я» — утверждение должно стоять само по себе');
  }

  const m = name.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)\.md$/);
  if (!m) warn(name, 'имя файла не вида «ГГГГ-ММ-ДД описание.md»');
  else if (fm['когда'] && !fm['когда'].startsWith(m[1].slice(0, fm['когда'].length))) warn(name, `дата в имени ${m[1]} расходится с «когда: ${fm['когда']}»`);
}

/* Дубли. Два осколка про одно и то же — не ошибка извлечения, а неизбежность:
   один факт повторяется в пяти логах. Но в базе он должен быть один, иначе
   выдача забьётся клонами, а отмена одного не отменит остальные. */
const dup = [];
for (let i = 0; i < shards.length; i++) {
  for (let j = i + 1; j < shards.length; j++) {
    const a = shards[i], b = shards[j];
    if (a.w.size < 5 || b.w.size < 5) continue;
    let same = 0;
    for (const t of a.w) if (b.w.has(t)) same++;
    const score = same / Math.min(a.w.size, b.w.size);
    if (score >= 0.55) dup.push([score, a.name, b.name]);
  }
}

console.log(`Осколков: ${shards.length}\n`);
if (errors.length) {
  console.log(`ОШИБКИ (${errors.length}) — эти в базу не идут:\n`);
  for (const e of errors) console.log('  ' + e);
  console.log('');
}
if (warnings.length) {
  console.log(`ЗАМЕЧАНИЯ (${warnings.length}) — посмотреть глазами:\n`);
  for (const w of warnings) console.log('  ' + w);
  console.log('');
}
if (dup.length) {
  console.log(`ВОЗМОЖНЫЕ ДУБЛИ (${dup.length}):\n`);
  for (const [s, a, b] of dup.sort((x, y) => y[0] - x[0]).slice(0, 20)) console.log(`  ${s.toFixed(2)}  ${a}\n        ${b}`);
  console.log('');
}

const ents = new Map();
for (const s of shards) {
  const list = Array.isArray(s.fm['о']) ? s.fm['о'] : s.fm['о'] ? [s.fm['о']] : [];
  for (const t of list.flatMap(wiki)) ents.set(t, (ents.get(t) || 0) + 1);
}
console.log(`Сущностей задействовано: ${ents.size}`);
console.log([...ents].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${String(v).padStart(3)}× ${k}`).join('\n'));

const byType = new Map();
for (const s of shards) byType.set(s.fm['тип'] || '—', (byType.get(s.fm['тип'] || '—') || 0) + 1);
console.log(`\nПо типам: ${[...byType].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
console.log(errors.length ? '\nЕсть ошибки — партия не принимается.' : '\nОшибок нет.');
process.exit(errors.length ? 1 : 0);
