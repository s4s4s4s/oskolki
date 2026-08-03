/**
 * Сверка порта поиска с оригиналом.
 *
 * js/search.js — копия ранжирования из `_tools/vault-mcp/worker.js`. Копии
 * расходятся молча: кто-то правит веса в воркере, приложение продолжает искать
 * по-старому, и человек видит разные ответы на один вопрос в чате и на карте.
 * Этот скрипт берёт функции ПРЯМО ИЗ ФАЙЛА воркера (без деплоя и сети), гоняет
 * оба поиска по настоящему индексу вальта и сравнивает выдачу.
 *
 * Запуск: node _dev/parity.mjs [--worker ПУТЬ] [--vault ПУТЬ]
 * Код возврата 1, если хоть один запрос дал разную выдачу.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareChunks, parseSynonyms, rankFiles, excerpt } from '../js/search.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const VAULT = resolve(arg('vault', 'C:/Users/sasha/Documents/Obsidian Vault'));
const WORKER = resolve(arg('worker', join(VAULT, '_tools/vault-mcp/worker.js')));

// Вырезаем из воркера блок «морфология + индекс + ранжирование» и оживляем его
// как есть. Так сверяется именно тот код, который работает в бою.
function loadWorkerSearch() {
  const src = readFileSync(WORKER, 'utf8');
  const from = src.indexOf('const SUFFIXES');
  const to = src.indexOf('/* ── разделы файлов');
  if (from < 0 || to < 0) throw new Error('не нашёл блок поиска в worker.js — проверь маркеры');
  const body = src.slice(from, to);
  const make = new Function(`${body}\nreturn { stems, parseSynonyms, rankFiles, excerpt, queryTerms };`);
  return make();
}

const QUERIES = [
  'ереван переезд', 'налоги ип армения', 'sat srs планировщик', 'полина',
  'vault mcp воркер', 'как работает индекс памяти', 'студия полякова лиды',
  'ночная консолидация', 'телеграм мост', 'квартира аренда', 'банковская карта',
  'что читаю', 'открытые вопросы', 'график сна', 'немецкая виза',
];

/* Пропуск и расхождение — разные вещи, и раньше они были неотличимы.
   При отсутствии вальта readFileSync бросал ENOENT, скрипт падал с кодом 1
   ровно как при настоящем расхождении, и шаг в CI пришлось глушить дважды:
   continue-on-error плюс `|| echo`. После этого сверка не могла упасть
   физически — то есть её просто не было.
   Теперь отсутствие вальта — честный выход 0 с громкой пометкой, а код 1
   означает только одно: две реализации поиска разошлись. */
const dir = join(VAULT, '_машина', 'индекс');
const синонимы = join(VAULT, '_машина', 'синонимы.md');
const нет = [
  [WORKER, 'worker.js'],
  [dir, '_машина/индекс'],
  [синонимы, '_машина/синонимы.md'],
].filter(([p]) => !existsSync(p));

if (нет.length) {
  const чего = нет.map(([, имя]) => имя).join(', ');
  // ::notice:: виден в сводке прогона — пропуск не должен выглядеть как проверка
  console.log(`::notice::сверка ранжирования ПРОПУЩЕНА: нет ${чего} (вальт в приватном репозитории)`);
  console.log(`⊘ сверка пропущена — недоступно: ${чего}`);
  process.exit(0);
}

const W = loadWorkerSearch();
const raw = [];
for (const f of readdirSync(dir)) {
  if (f.endsWith('.json') && f !== 'meta.json') raw.push(...JSON.parse(readFileSync(join(dir, f), 'utf8')));
}
const synText = readFileSync(синонимы, 'utf8');

// как воркер готовит куски при загрузке индекса
const wChunks = raw.map(c => ({ p: c.p, h: c.h || [], t: c.t, body: W.stems(c.t), meta: W.stems(`${(c.h || []).join(' ')} ${c.p}`) }));
const wSyn = W.parseSynonyms(synText);

const aChunks = prepareChunks(raw);
const aSyn = parseSynonyms(synText);

let bad = 0;
for (const q of QUERIES) {
  const w = W.rankFiles(wChunks, q, wSyn, 6);
  const a = rankFiles(aChunks, q, aSyn, 6);
  const wp = w.files.map(f => f.p), ap = a.files.map(f => f.p);
  const same = wp.length === ap.length && wp.every((p, i) => p === ap[i]);
  const wFrag = w.files[0] ? W.excerpt(w.files[0].best.c.t, w.terms) : '';
  const aFrag = a.files[0] ? excerpt(a.files[0].best.c.t, a.terms) : '';
  const sameFrag = wFrag === aFrag;
  if (!same || !sameFrag) {
    bad++;
    console.log(`РАСХОЖДЕНИЕ «${q}»`);
    if (!same) { console.log('  воркер:     ', wp.join(' | ')); console.log('  приложение: ', ap.join(' | ')); }
    if (!sameFrag) { console.log('  фрагмент воркера:     ', wFrag.slice(0, 120)); console.log('  фрагмент приложения:  ', aFrag.slice(0, 120)); }
  }
}

console.log(bad
  ? `\n✗ разошлись на ${bad} из ${QUERIES.length} запросов — правь js/search.js под worker.js`
  : `\n✓ выдача совпала на всех ${QUERIES.length} запросах (${aChunks.length} кусков, ${aSyn.length} групп синонимов)`);
process.exit(bad ? 1 : 0);
