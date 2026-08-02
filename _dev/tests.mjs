/**
 * Тесты. Без зависимостей: встроенный `node:test`, запуск `node --test _dev/`.
 *
 * Появились не для галочки. Сегодня разметчик классов съел пустую строку между
 * фронтматтером и текстом во всех 682 файлах вальта, и это уехало в коммит —
 * поймалось только глазами, случайно. Один круговой прогон «разобрал → собрал →
 * сверил байты» ловит такое за миллисекунды.
 *
 * Поэтому здесь проверяется не «работают ли функции», а ровно те инварианты,
 * нарушение которых уже стоило потерянного времени или испорченных данных:
 *
 *   1. чтение и запись фронтматтера не меняют ни байта тела;
 *   2. вложенные списки и wikilinks переживают круговой прогон;
 *   3. язык запросов разбирает то, что обещает;
 *   4. дифф не теряет строк;
 *   5. ранжирование приложения совпадает с воркерным (это же ловит parity.mjs,
 *      здесь — дешёвая проверка на подмену стеммера).
 *
 * Тесты идут по НАСТОЯЩЕМУ вальту, если он на месте: синтетика на круговом
 * прогоне бесполезна — ломается всегда на живых данных, где встречаются
 * многострочные списки, кавычки, кириллица в ключах и BOM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

/* Заглушки браузерных глобалей до импортов приложения.

   Модули приложения написаны для браузера и при загрузке читают localStorage и
   адрес страницы. Городить в них ветки «а вдруг мы в Node» ради тестов — значит
   портить рабочий код в угоду тестам; дешевле и честнее подменить среду здесь. */
globalThis.localStorage ??= {
  _: new Map(),
  getItem(k) { return this._.has(k) ? this._.get(k) : null; },
  setItem(k, v) { this._.set(k, String(v)); },
  removeItem(k) { this._.delete(k); },
};
globalThis.location ??= { hostname: 'localhost', hash: '', search: '' };
globalThis.indexedDB ??= { open: () => ({ addEventListener() {} }) };
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { parseFm, stringifyFm, applyFm, FM_RE, addTag, removeTag, addLink, setField } from '../js/frontmatter.js';
import { parseQuery, matches } from '../js/query.js';
import { diffLines, collapseSame } from '../js/diff.js';
import { stem, stems, queryTerms } from '../js/search.js';

const VAULT = process.env.VAULT || 'C:/Users/sasha/Documents/Obsidian Vault';
const есть = existsSync(join(VAULT, '.git'));

const файлыВальта = () => {
  if (!есть) return [];
  return execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
    cwd: VAULT, encoding: 'utf8', maxBuffer: 64 << 20,
  }).split('\0').filter(f => f.endsWith('.md'));
};

/* ── круговой прогон фронтматтера ─────────────────────────────────────────── */

test('фронтматтер: разбор и сборка не меняют тело ни на байт', { skip: !есть && 'вальт недоступен' }, () => {
  const files = файлыВальта();
  assert.ok(files.length > 100, `в вальте ${files.length} заметок — похоже, не тот путь`);
  let проверено = 0, сломано = [];
  for (const f of files) {
    let raw;
    try { raw = readFileSync(join(VAULT, f), 'utf8'); } catch { continue; }
    const text = raw.replace(/^\uFEFF/, '');
    const m = text.match(FM_RE);
    if (!m) continue;                       // без фронтматтера нечего проверять
    const телоДо = text.slice(m[0].length);
    // applyFm — то, чем пишут все правки фронтматтера: теги, связи, поля.
    const { fm, order } = parseFm(text);
    const после = applyFm(text, fm, order);
    const m2 = после.match(FM_RE);
    const телоПосле = после.slice(m2[0].length);
    if (телоПосле !== телоДо) сломано.push(f);
    проверено++;
  }
  assert.equal(сломано.length, 0, `тело изменилось в ${сломано.length} файлах, например: ${сломано.slice(0, 3).join(', ')}`);
  assert.ok(проверено > 100, `проверено всего ${проверено} файлов с фронтматтером`);
});

test('фронтматтер: правки полей не трогают чужие ключи и порядок', () => {
  const исходник = [
    '---',
    'type: note',
    'класс: утверждение',
    'tags: [ai, log]',
    'о: ["[[Ксюша]]", "[[Ереван]]"]',
    'description: "строка с двоеточием: и кавычками"',
    '---',
    '',
    '# Заголовок',
    '',
    'Тело с [[ссылкой]] и списком:',
    '- один',
    '- два',
    '',
  ].join('\n');
  const после = addTag(исходник, 'новый');
  const { fm, order } = parseFm(после);
  assert.equal(fm.type, 'note', 'потерян чужой ключ');
  assert.equal(fm['класс'], 'утверждение', 'потерян кириллический ключ');
  assert.deepEqual(fm['о'], ['[[Ксюша]]', '[[Ереван]]'], 'испорчено поле со ссылками');
  assert.ok(fm.description.includes('двоеточием'), 'испорчена строка с двоеточием');
  assert.deepEqual(order.slice(0, 3), ['type', 'класс', 'tags'], 'сбит порядок ключей');
  assert.ok(после.includes('- один\n- два'), 'испорчен список в теле');
  assert.ok(после.split('---\n')[2].startsWith('\n# Заголовок'), 'съедена пустая строка после фронтматтера');
});

test('фронтматтер: wikilink в значении не превращается во вложенный массив', () => {
  // Реальная поломка: без кавычек «о: [[[Ксюша]]]» — это YAML-массив в массиве,
  // и Obsidian такую связь не видит вообще.
  const s = addLink('---\ntype: note\n---\n\nтекст\n', 'relates', 'Ксюша');
  assert.ok(!/\[\[\[/.test(s), `получились тройные скобки: ${s.match(/relates.*/)?.[0]}`);
  const { fm } = parseFm(s);
  assert.deepEqual(fm.relates, ['[[Ксюша]]']);
});

test('фронтматтер: снятие тега не оставляет пустой ключ мусором', () => {
  const s = removeTag('---\ntags: [один]\n---\n\nтело\n', 'один');
  const { fm } = parseFm(s);
  assert.ok(!fm.tags || fm.tags.length === 0);
  assert.ok(s.includes('\nтело\n'), 'потеряно тело');
});

/* ── язык запросов ────────────────────────────────────────────────────────── */

test('запросы: разбор фильтров и отрицаний', () => {
  const q = parseQuery('переезд tag:проект -is:done класс:утверждение "точная фраза"');
  assert.equal(q.text.trim(), 'переезд');
  assert.deepEqual(q.phrases, ['точная фраза']);
  const ключи = q.filters.map(f => f.key + (f.neg ? '!' : ''));
  assert.ok(ключи.includes('tag'), 'потерян tag:');
  assert.ok(ключи.includes('is!'), 'потеряно отрицание');
  assert.ok(ключи.includes('класс'), 'потерян кириллический фильтр');
});

test('запросы: тег ловит вложенные, но не однокоренные', () => {
  const q = parseQuery('tag:проект');
  const note = t => ({ tags: t, links: [], backlinks: [], meta: {}, path: '', title: '', zone: '' });
  assert.equal(matches(note(['проект/ереван']), q), true, 'вложенный тег должен подходить');
  assert.equal(matches(note(['проект']), q), true);
  assert.equal(matches(note(['проектирование']), q), false, 'однокоренной тег подходить не должен');
});

/* ── дифф ─────────────────────────────────────────────────────────────────── */

test('дифф: ни одна строка не теряется и не удваивается', () => {
  const было = 'а\nб\nв\nг\nд';
  const стало = 'а\nБ\nв\nд\nе';
  const parts = diffLines(было, стало);
  const собрано = (тип) => parts.filter(p => p.type === 'same' || p.type === тип).flatMap(p => p.text.split('\n')).join('\n');
  assert.equal(собрано('del'), было, 'левая сторона диффа не сходится с исходником');
  assert.equal(собрано('add'), стало, 'правая сторона диффа не сходится с результатом');
});

test('дифф: схлопывание оставляет расхождения на месте', () => {
  const было = Array.from({ length: 40 }, (_, i) => `строка ${i}`).join('\n');
  const стало = было.replace('строка 20', 'строка ДВАДЦАТЬ');
  const parts = collapseSame(diffLines(было, стало), 2);
  assert.ok(parts.some(p => p.type === 'skip'), 'длинное совпадение не схлопнулось');
  assert.ok(parts.some(p => p.type === 'add' && p.text.includes('ДВАДЦАТЬ')), 'потеряно расхождение');
});

/* ── морфология ───────────────────────────────────────────────────────────── */

test('морфология: формы одного слова сходятся в одну основу', () => {
  for (const группа of [
    ['переезд', 'переезда', 'переезды'],
    ['налог', 'налога', 'налоги', 'налогов'],
    ['карточка', 'карточки', 'карточках'],
  ]) {
    const основы = new Set(группа.map(stem));
    assert.equal(основы.size, 1, `${группа.join('/')} дали разные основы: ${[...основы].join(', ')}`);
  }
});

test('морфология: транслит и кириллица дают общий ключ', () => {
  const s = stems('впн');
  assert.ok([...s].some(k => /^vpn|vp/.test(k)), `нет транслитного ключа: ${[...s].join(', ')}`);
});

test('морфология: стоп-слова не попадают в запрос', () => {
  const terms = queryTerms('зачем вообще нужен впн', []);
  const слова = terms.map(t => (Array.isArray(t) ? t[0] : t));
  assert.ok(!слова.some(w => /^зач|^вообщ|^нуж/.test(w)), `в запросе остались служебные слова: ${слова.join(', ')}`);
});
