/**
 * Разметка вальта по классам памяти.
 *
 * Классы описаны в `resources/Система памяти/Классы памяти.md`: сущность,
 * утверждение, событие, улика, выводимое. Класс — это поведение объекта
 * (стареет ли, может ли противоречить, кто создаёт), а не тема.
 *
 * Скрипт проставляет `класс` и `тип` во фронтматтер по механическим правилам.
 * Нынешнее поле `type` смешивало уровни (`note`, `person`, `task`, `card` — это
 * и класс, и тип сразу), поэтому оно не трогается: старое остаётся как есть,
 * новое кладётся рядом. Ничего не ломается у Обсидиана и Dataview, а откат —
 * это `git revert` одного коммита.
 *
 * По умолчанию только показывает, что собирается сделать. Запись — с `--apply`.
 *
 * Запуск: node _dev/classify.mjs [--vault <путь>] [--apply]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, posix } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const VAULT = resolve(flag('vault', 'C:/Users/sasha/Documents/Obsidian Vault'));
const APPLY = args.includes('--apply');

const files = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
  cwd: VAULT, encoding: 'utf8', maxBuffer: 64 << 20,
}).split('\0').filter(f => f.endsWith('.md'));

/* Правила. Порядок важен: первое совпавшее выигрывает. Всё, что не опознано
   уверенно, остаётся без класса — лучше пустое поле, чем неверное: неверный
   класс задаёт объекту неверное поведение, и это тише и опаснее, чем его
   отсутствие. */
const RULES = [
  // Второй аргумент — фронтматтер: у осколка тип уже проставлен при извлечении,
  // и перебивать его нельзя. (Раньше здесь стоял одноаргументный вид, которому
  // приходил путь, — все типы молча схлопывались в «факт».)
  [/^осколки\//,                         'утверждение', (p, fm) => fm['тип'] || 'факт'],
  [/^_машина\//,                         'выводимое',   () => 'индекс'],
  // Ядро вальта разбирается поимённо: это два десятка файлов, и каждый из них
  // ведёт себя по-своему. Правило по папке `brain/` было бы враньём — там рядом
  // лежат решения, сводки, профиль человека и накопитель наблюдений.
  [/^brain\/decisions\//,                'утверждение', () => 'решение'],
  [/^brain\/(North Star|Открытые вопросы)\.md$/, 'утверждение', () => 'намерение'],
  [/^brain\/patterns\.md$/,              'утверждение', () => 'наблюдение'],
  [/^(brain\/(Profile|Здоровье)|Учёба\/Профиль)\.md$/, 'сущность', () => 'человек'],
  [/^(Home|brain\/(hot|index|log|watchlist)|Учёба\/(Состояние|Метрики|Карта пробелов))\.md$/, 'выводимое', () => 'сводка'],
  [/^Учёба\/.*(шаблон|Шаблон)/,          'выводимое',   () => 'шаблон'],
  [/^Учёба\/(План|Протокол)/,            'утверждение', () => 'правило'],
  // Очередь — это улики (что кому поручали), а не инструменты; правило про
  // `_tools/` должно её пропускать, иначе задания попадают в список сущностей
  // и извлечение начинает вешать факты на файлы заданий.
  [/^_tools\/queue\//,                    'улика',       () => 'задание'],
  [/^(CLAUDE|README)\.md$|^_tools\//,    'сущность',    () => 'инструмент'],
  [/^(archive|brain\/log|daily)\//,      'улика',       p => /telegram|срез/i.test(p) ? 'выгрузка' : /^daily/.test(p) ? 'дневник' : 'журнал'],
  [/^people\//,                          'сущность',    () => 'человек'],
  [/^projects\//,                        'сущность',    () => 'проект'],
  [/^areas\//,                           'сущность',    () => 'область'],
  [/^templates\//,                       'выводимое',   () => 'шаблон'],
  [/^Учёба\/Карточки\//,                 'выводимое',   () => 'карточка'],
  [/^Учёба\/(Лог сессий|Журнал ошибок)/, 'улика',       () => 'журнал'],
  [/^resources\//,                       'сущность',    () => 'понятие'],
];

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

// Свой разбор фронтматтера, а не YAML-библиотека: нужны только скаляры, и
// порядок ключей обязан сохраниться — иначе диффы станут нечитаемыми.
function parseFm(text) {
  const m = text.match(FM_RE);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-zА-Яа-яЁё_][\w\u0400-\u04FF-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, head: m[1], rest: text.slice(m[0].length) };
}

const stats = new Map();
const changes = [];
let noFm = 0, already = 0;

for (const f of files) {
  const rule = RULES.find(([re]) => re.test(f));
  if (!rule) continue;
  const [, klass, typeOf] = rule;
  let raw;
  try { raw = readFileSync(join(VAULT, f), 'utf8'); } catch { continue; }
  const parsed = parseFm(raw.replace(/^\uFEFF/, ''));
  if (!parsed) { noFm++; continue; }
  const тип = typeOf(f, parsed.fm);
  if (parsed.fm['класс'] === klass && parsed.fm['тип'] === тип) { already++; continue; }

  const key = `${klass} · ${тип}`;
  stats.set(key, (stats.get(key) || 0) + 1);
  changes.push({ f, klass, тип, parsed, raw });
}

console.log(`Файлов в вальте: ${files.length}. Размечается: ${changes.length}. Уже размечено: ${already}. Без фронтматтера: ${noFm}.\n`);
for (const [k, n] of [...stats].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

const untouched = files.filter(f => !RULES.some(([re]) => re.test(f)));
console.log(`\nБез класса остаются ${untouched.length}: правило не сработало уверенно.`);
for (const f of untouched.slice(0, 12)) console.log(`  ${f}`);
if (untouched.length > 12) console.log(`  …и ещё ${untouched.length - 12}`);

if (!APPLY) {
  console.log('\nЭто сухой прогон, ничего не записано. Запись — с флагом --apply.');
  process.exit(0);
}

/* Пишем оба поля сразу после `type`, если он есть, иначе первой строкой:
   фронтматтер читают глазами, и поля про природу объекта должны стоять вместе,
   а не в хвосте после десяти технических. */
let written = 0;
for (const { f, klass, тип, parsed, raw } of changes) {
  const lines = parsed.head.split(/\r?\n/).filter(l => !/^(класс|тип):/.test(l));
  const at = lines.findIndex(l => /^type:/.test(l));
  const add = [`класс: ${klass}`, `тип: ${тип}`];
  lines.splice(at >= 0 ? at + 1 : 0, 0, ...add);
  // Тело не трогаем ни на байт: закрывающий перевод строки уже съеден регуляркой,
  // поэтому `rest` начинается ровно с того, что шло за фронтматтером, — включая
  // пустую строку. Срезать её здесь означало бы поменять все 682 файла ради ничего.
  const out = `---\n${lines.join('\n')}\n---\n${parsed.rest}`;
  writeFileSync(join(VAULT, f), out, 'utf8');
  written++;
}
console.log(`\nЗаписано файлов: ${written}. Откат — git revert одного коммита.`);
