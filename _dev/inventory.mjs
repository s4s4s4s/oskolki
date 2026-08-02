/**
 * Инвентаризация вальта: из чего он состоит на самом деле.
 *
 * Вальт рос как архив — журналы сессий, выгрузки переписок, дневники, карточки,
 * и где-то между ними настоящие решения и справки. Прежде чем собирать из этого
 * базу знаний, надо честно посчитать, чего сколько: сколько объёма занимает
 * хроника, сколько заметок вообще ни с чем не связано, где лежат дубли и что
 * из этого похоже на готовое знание, а что — на сырьё.
 *
 * Скрипт ничего не меняет. Он читает уже собранную карту (`_машина/карта`) и
 * печатает картину. Все оценки — механические: никакой модели, никаких догадок.
 *
 * Запуск: node _dev/inventory.mjs [--vault <путь>]
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const VAULT = resolve(flag('vault', 'C:/Users/sasha/Documents/Obsidian Vault'));
const MAP = join(VAULT, '_машина/карта');

const readJson = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const map = readJson(join(MAP, 'карта.json'));
const keys = readJson(join(MAP, 'ключи.json'));
const notes = map.n || map.notes || map;

const kb = b => (b / 1024).toFixed(0) + ' КБ';
const pct = (a, b) => b ? `${(a / b * 100).toFixed(0)}%` : '0%';
const bar = (a, b, w = 28) => '█'.repeat(Math.round(a / (b || 1) * w)).padEnd(w, '·');

/* Классификация. Не по папке и не по типу из фронтматтера, а по тому, чем
   заметка является на деле: журнал сессии — это хроника, даже если лежит в
   brain и помечена note. Правила грубые намеренно — важен порядок величин. */
const CLASS = [
  ['карточка', n => /^Учёба\/Карточки\//.test(n.p) || n.ty === 'card'],
  ['хроника', n => /^(brain\/log|daily|_tools\/queue|archive)\//.test(n.p) || /Лог|Telegram-срез|срез /i.test(n.t)],
  ['человек', n => n.ty === 'person' || /^people\//.test(n.p)],
  ['задача', n => n.ty === 'task' || /^_tools\/queue/.test(n.p)],
  ['шаблон', n => /^templates\//.test(n.p)],
  ['служебное', n => /^_tools\//.test(n.p) || /^_machine|^_машина/.test(n.p)],
  ['проект', n => /^projects\//.test(n.p)],
  ['область', n => /^areas\//.test(n.p)],
  ['справка', n => /^resources\//.test(n.p)],
  ['учёба', n => /^Учёба\//.test(n.p)],
  ['ядро', n => /^brain\//.test(n.p)],
];
const classOf = n => (CLASS.find(([, f]) => f(n)) || ['прочее'])[0];

const groups = new Map();
for (const n of notes) {
  const c = classOf(n);
  if (!groups.has(c)) groups.set(c, { n: 0, b: 0, links: 0, tagged: 0, orphan: 0 });
  const g = groups.get(c);
  g.n++; g.b += n.b || 0;
  g.links += (n.ln || []).length;
  if ((n.tg || []).length) g.tagged++;
}
const backCount = new Map();
notes.forEach(n => (n.ln || []).forEach(([to]) => backCount.set(to, (backCount.get(to) || 0) + 1)));
notes.forEach((n, i) => { if (!backCount.get(i)) groups.get(classOf(n)).orphan++; });

const total = notes.length;
const totalB = notes.reduce((a, n) => a + (n.b || 0), 0);

console.log(`\nВАЛЬТ: ${total} заметок, ${kb(totalB)} текста\n`);
console.log('  класс         шт      объём   доля объёма                   связей  с тегами  сирот');
for (const [c, g] of [...groups].sort((a, b) => b[1].b - a[1].b)) {
  console.log(`  ${c.padEnd(12)} ${String(g.n).padStart(4)}  ${kb(g.b).padStart(8)}  ${bar(g.b, totalB)} ${pct(g.b, totalB).padStart(4)}  ${String(g.links).padStart(5)}  ${String(g.tagged).padStart(7)}  ${String(g.orphan).padStart(5)}`);
}

/* Сколько тут «знания», а сколько «протокола». Знание — то, что останется
   верным через год; протокол — запись о том, что происходило в такой-то день.
   Механически различить их нельзя, но можно оценить сверху: всё, что не хроника,
   не карточки и не служебное. */
const noise = ['карточка', 'хроника', 'служебное', 'шаблон', 'задача'];
const core = notes.filter(n => !noise.includes(classOf(n)));
const coreB = core.reduce((a, n) => a + (n.b || 0), 0);
console.log(`\nСодержательный слой (без хроники, карточек и служебного): ${core.length} заметок, ${kb(coreB)} — ${pct(coreB, totalB)} объёма и ${pct(core.length, total)} штук.`);

/* Дубли. Точного совпадения искать бессмысленно — повторяются не файлы, а факты.
   Дешёвая оценка сверху: пары заметок, у которых совпадает больше половины
   ключевых слов. Это не приговор «дубль», а список кандидатов на слияние. */
const kwOf = i => new Set((keys[i] || []).filter(t => /[а-яё]/.test(t)));
const pairs = [];
for (let i = 0; i < notes.length; i++) {
  const a = kwOf(i);
  if (a.size < 4) continue;
  for (let j = i + 1; j < notes.length; j++) {
    const b = kwOf(j);
    if (b.size < 4) continue;
    let same = 0;
    for (const t of a) if (b.has(t)) same++;
    const score = same / Math.min(a.size, b.size);
    if (score >= 0.6) pairs.push([score, notes[i], notes[j]]);
  }
}
pairs.sort((x, y) => y[0] - x[0]);
console.log(`\nКандидаты на слияние (совпадает больше половины ключевых слов): ${pairs.length} пар.`);
for (const [s, a, b] of pairs.slice(0, 12)) console.log(`  ${s.toFixed(2)}  ${a.t}  ⟷  ${b.t}`);

// Что уже похоже на готовое знание: связано, помечено, не хроника, не гигант.
const ready = core.filter((n, i) => (n.tg || []).length && (n.ln || []).length && (n.b || 0) < 20000);
console.log(`\nПохоже на готовое знание (есть теги, есть связи, меньше 20 КБ): ${ready.length} из ${core.length} содержательных.`);

// Крупные заметки — их придётся резать: в них по нескольку тем сразу.
const fat = core.filter(n => (n.b || 0) > 15000).sort((a, b) => b.b - a.b);
console.log(`\nСлишком крупные для одной мысли (>15 КБ): ${fat.length}`);
for (const n of fat.slice(0, 10)) console.log(`  ${kb(n.b).padStart(8)}  ${n.t}  (${(n.hd || []).length} заголовков)`);

const noTags = core.filter(n => !(n.tg || []).length).length;
const noLinks = core.filter(n => !(n.ln || []).length).length;
console.log(`\nВ содержательном слое: без тегов ${noTags} (${pct(noTags, core.length)}), без исходящих связей ${noLinks} (${pct(noLinks, core.length)}).`);
console.log('');
