/**
 * Мерилка поиска: BM25 против гибрида.
 *
 * Векторы стоят места, времени сборки и отдельного эндпоинта. Ставить их в
 * систему «потому что так делают» — плохая причина; ставить, потому что они
 * находят то, что не находит BM25, — хорошая. Разница между этими случаями
 * измеряется, а не обсуждается, и вот чем.
 *
 * Как устроено: золотой набор — это вопросы, заданные человеческими словами, и
 * заметка, которая на них отвечает. Считаются три числа:
 *   попадание@1  — сколько раз нужное первым;
 *   попадание@5  — сколько раз нужное в пятёрке (столько человек и просматривает);
 *   MRR          — 1/место, среднее: чувствителен к тому, поднялось ли нужное
 *                  с пятого места на второе, а не только к «вошло/не вошло».
 *
 * Приговор простой: если гибрид не выигрывает у BM25 хотя бы по MRR и
 * попаданию@5, слой не нужен — его надо выключить, а не оставлять «на будущее».
 *
 * Запуск:
 *   node _dev/eval.mjs                      — только BM25 (векторов может и не быть)
 *   node _dev/eval.mjs --vectors <папка>    — сравнение с гибридом
 *   node _dev/eval.mjs --url … --model …    — чем считать вектор вопроса
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareChunks, parseSynonyms, rankFiles } from '../js/search.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const VAULT = resolve(String(flag('vault', 'C:/Users/sasha/Documents/Obsidian Vault')));
const VECDIR = flag('vectors', null) ? resolve(String(flag('vectors'))) : null;
const URL_ = String(flag('url', 'http://localhost:11434/api/embeddings'));
const MODEL = String(flag('model', 'nomic-embed-text'));

/* Золотой набор. Вопросы намеренно заданы не теми словами, что в заметках, —
   иначе меряется не поиск, а совпадение строк. Ответ — путь заметки, которая
   действительно отвечает; если таких несколько, годится любая из перечисленных. */
const GOLD = [
  { q: 'куда переезжаю и когда', ok: [/Образование и релокация/i, /релокац/i] },
  { q: 'что с налогами после переезда', ok: [/релокац/i, /Финансы/i] },
  { q: 'как перевести акции из реестра', ok: [/Т-Банк/i] },
  { q: 'кто такая Ксюша', ok: [/Ксюш/i] },
  { q: 'чем занимается студия для салонов', ok: [/Студия Полякова/i] },
  { q: 'сколько баллов на последнем пробнике', ok: [/Разбор PT/i, /Лог сессий/i] },
  { q: 'зачем нужна карта вальта', ok: [/vault-mcp/i, /Архитектура Second Brain/i, /Индекс памяти/i] },
  { q: 'какие цели на год', ok: [/North Star/i, /Главная/i] },
  { q: 'что сейчас горит', ok: [/hot/i] },
  { q: 'чем сейчас занят по работе', ok: [/hot/i, /Главная/i, /Студия Полякова/i] },
  { q: 'план подготовки к экзамену по чтению', ok: [/План RW/i] },
  { q: 'как устроено повторение слов', ok: [/SRS/i, /Карточки/i, /система уровней/i] },
  { q: 'что решили про архитектуру памяти', ok: [/Архитектура Second Brain/i, /Индекс памяти/i] },
  { q: 'кто помогает с учёбой', ok: [/Эвальд/i, /Ксюш/i] },
  { q: 'что не работает и подвисло', ok: [/Открытые вопросы/i, /hot/i] },
];

const loadIndex = () => {
  const dir = join(VAULT, '_машина/индекс');
  const chunks = [];
  for (const f of readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).sort()) {
    chunks.push(...JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, '')));
  }
  const syn = existsSync(join(VAULT, '_машина/синонимы.md')) ? readFileSync(join(VAULT, '_машина/синонимы.md'), 'utf8') : '';
  return { chunks: prepareChunks(chunks), synonyms: parseSynonyms(syn) };
};

async function embed(text) {
  const isOllama = /\/api\/embed/.test(URL_);
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(process.env.EMBED_KEY ? { authorization: `Bearer ${process.env.EMBED_KEY}` } : {}) },
    body: JSON.stringify(isOllama ? { model: MODEL, prompt: text } : { model: MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`эндпоинт ответил ${r.status}`);
  const j = await r.json();
  const v = j.embedding || j.data?.[0]?.embedding;
  if (!Array.isArray(v)) throw new Error('в ответе нет вектора');
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return Float32Array.from(v, x => x / n);
}

function loadVectors(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'манифест.json'), 'utf8'));
  const chunks = JSON.parse(readFileSync(join(dir, 'куски.json'), 'utf8'));
  const shards = [];
  for (let s = 0; s < manifest.shards; s++) {
    // Шард — int8 в base64 внутри json: тот же файл читают и приложение, и воркер,
    // который умеет отдавать только текст.
    const { b64 } = JSON.parse(readFileSync(join(dir, `${String(s).padStart(3, '0')}.json`), 'utf8'));
    const buf = Buffer.from(b64, 'base64');
    shards.push(new Int8Array(buf.buffer, buf.byteOffset, buf.length));
  }
  return { manifest, chunks, shards };
}

function vecSearch(V, q, limit) {
  const { dim, perShard } = V.manifest;
  const all = [];
  V.shards.forEach((data, s) => {
    const rows = Math.floor(data.length / dim);
    for (let r = 0; r < rows; r++) {
      let dot = 0; const off = r * dim;
      for (let d = 0; d < dim; d++) dot += q[d] * data[off + d];
      all.push([s * perShard + r, dot / 127]);
    }
  });
  all.sort((a, b) => b[1] - a[1]);
  const seen = new Map();
  for (const [i, sc] of all) {
    const c = V.chunks[i];
    if (c && !seen.has(c.p)) seen.set(c.p, sc);
    if (seen.size >= limit) break;
  }
  return [...seen.keys()];
}

const rrf = (lists, k = 60, limit = 10) => {
  const s = new Map();
  for (const list of lists) list.forEach((p, i) => s.set(p, (s.get(p) || 0) + 1 / (k + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(x => x[0]);
};

const place = (paths, ok) => {
  const i = paths.findIndex(p => ok.some(re => re.test(p)));
  return i < 0 ? null : i + 1;
};

function report(name, places) {
  const hit1 = places.filter(p => p === 1).length;
  const hit5 = places.filter(p => p && p <= 5).length;
  const mrr = places.reduce((a, p) => a + (p ? 1 / p : 0), 0) / places.length;
  console.log(`${name.padEnd(10)} попадание@1 ${String(hit1).padStart(2)}/${places.length}   попадание@5 ${String(hit5).padStart(2)}/${places.length}   MRR ${mrr.toFixed(3)}`);
  return { hit1, hit5, mrr };
}

async function main() {
  const { chunks, synonyms } = loadIndex();
  console.log(`Вальт: ${VAULT}\nФрагментов в индексе: ${chunks.length}\nВопросов в наборе: ${GOLD.length}\n`);

  const bm = [], hy = [], ve = [];
  let V = null;
  if (VECDIR) {
    try { V = loadVectors(VECDIR); console.log(`Векторы: ${V.manifest.count} кусков, ${V.manifest.dim} измерений, модель ${V.manifest.model}\n`); }
    catch (e) { console.error(`Векторы не прочитаны (${e.message}) — меряю только BM25.\n`); }
  }

  for (const g of GOLD) {
    const { files } = rankFiles(chunks, g.q, synonyms, 10);
    const bmPaths = files.map(f => f.p);
    bm.push(place(bmPaths, g.ok));

    if (V) {
      let vPaths = [];
      try { vPaths = vecSearch(V, await embed(g.q), 10); }
      catch (e) { console.error(`  вектор вопроса «${g.q}» не посчитан: ${e.message}`); V = null; }
      if (V) {
        ve.push(place(vPaths, g.ok));
        hy.push(place(rrf([bmPaths, vPaths]), g.ok));
      }
    }
    const p = bm[bm.length - 1];
    console.log(`${p ? String(p).padStart(2) : ' —'}  ${g.q}${p ? '' : `   ← BM25 не нашёл: ${bmPaths.slice(0, 3).join(', ')}`}`);
  }

  console.log('');
  const a = report('BM25', bm);
  if (V && hy.length) {
    const v = report('векторы', ve);
    const h = report('гибрид', hy);
    console.log('');
    const better = h.mrr > a.mrr + 0.02 && h.hit5 >= a.hit5;
    console.log(better
      ? `Вывод: гибрид выигрывает (MRR ${a.mrr.toFixed(3)} → ${h.mrr.toFixed(3)}) — слой стоит держать включённым.`
      : `Вывод: гибрид НЕ выигрывает (MRR ${a.mrr.toFixed(3)} → ${h.mrr.toFixed(3)}, векторы сами по себе ${v.mrr.toFixed(3)}). Слой надо выключить, а не оставлять «на будущее».`);
  } else if (VECDIR) {
    console.log('Сравнения не вышло: векторы или эндпоинт недоступны.');
  } else {
    console.log('Векторы не мерялись: запусти с --vectors <папка>, когда они будут собраны.');
  }
}

main();
