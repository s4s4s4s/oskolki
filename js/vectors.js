// Векторный слой: смысловой поиск в дополнение к словесному.
//
// Зачем. BM25 находит названное своим именем и не находит забытое: «как
// называлась та штука, куда кладут деньги для визы» не содержит слова
// «Sperrkonto», и по словам не найдётся ничего. Векторы отвечают на такие
// вопросы и заметно хуже отвечают на точные — «PT4» они размывают в «какой-то
// тест». Поэтому здесь не замена поиску, а слагаемое: два списка складываются
// ранговым способом (RRF), и выигрывает то, что высоко в обоих.
//
// Слой необязательный по построению. Нет собранных векторов или нечем посчитать
// вектор запроса — приложение об этом молчит и работает как раньше. Никакой
// деградации, никаких пустых экранов: BM25 остаётся основным и самодостаточным.
//
// Что нужно для работы:
//   1. собранные векторы в вальте (_машина/векторы, см. build-vectors.mjs);
//   2. эндпоинт эмбеддингов, доступный из приложения, — чтобы посчитать вектор
//      запроса. По умолчанию локальная ollama; адрес настраивается и хранится
//      только на этом устройстве.
import { MAP_DIR } from './config.js';
import { tools } from './api.js';

const LS_KEY = 'shards.embed';
export const getEmbedSettings = () => {
  try { return { url: 'http://localhost:11434/api/embeddings', model: 'nomic-embed-text', on: false, ...JSON.parse(localStorage.getItem(LS_KEY)) }; }
  catch { return { url: 'http://localhost:11434/api/embeddings', model: 'nomic-embed-text', on: false }; }
};
export const saveEmbedSettings = s => localStorage.setItem(LS_KEY, JSON.stringify({ ...getEmbedSettings(), ...s }));

const DIR = MAP_DIR.replace(/карта$/, 'векторы');

export const vecState = { ready: false, checked: false, error: null, manifest: null, chunks: null, shards: [], loaded: 0 };

const readJson = async path => JSON.parse((await tools.read(path)).replace(/^﻿/, ''));

/* Манифест и список кусков — маленькие, читаются сразу. Сами векторы лежат
   шардами и подтягиваются по мере надобности: на десяти тысячах заметок это
   14 МБ, и тянуть их ради одного запроса, который может и не понадобиться,
   незачем. */
export async function initVectors() {
  if (vecState.checked) return vecState.ready;
  vecState.checked = true;
  try {
    vecState.manifest = await readJson(`${DIR}/манифест.json`);
    vecState.chunks = await readJson(`${DIR}/куски.json`);
    vecState.ready = !!vecState.manifest?.dim && vecState.chunks?.length > 0;
  } catch (e) {
    vecState.error = e.message;
    vecState.ready = false;
  }
  return vecState.ready;
}

/* Шард — int8-векторы, упакованные в base64 внутри обычного json. Так они
   читаются тем же каналом, что и заметки: в вебе воркер отдаёт только текст, и
   сырые байты по нему не проходят. Треть лишнего объёма — плата за то, что
   бинарного контура нет вообще ни в вебе, ни в приложении, ни на стенде. */
async function shard(i) {
  if (vecState.shards[i]) return vecState.shards[i];
  const { b64 } = await readJson(`${DIR}/${String(i).padStart(3, '0')}.json`);
  const bin = atob(b64);
  const arr = new Int8Array(bin.length);
  for (let k = 0; k < bin.length; k++) arr[k] = (bin.charCodeAt(k) << 24) >> 24;   // байт → знаковый int8
  vecState.shards[i] = arr;
  vecState.loaded += arr.length;
  return arr;
}

/* Вектор запроса. Считается тем же эндпоинтом, что и вектора вальта, — иначе
   пространства разные и косинус между ними ничего не значит. Модель в манифесте
   сверяется с настройкой: молчаливое расхождение здесь дало бы правдоподобную
   чушь в выдаче, что хуже пустого результата. */
export async function embedQuery(text) {
  const s = getEmbedSettings();
  if (!s.on) throw new Error('смысловой поиск выключен');
  if (vecState.manifest && s.model && vecState.manifest.model !== s.model) {
    throw new Error(`векторы собраны моделью ${vecState.manifest.model}, а настроена ${s.model}`);
  }
  const isOllama = /\/api\/embed/.test(s.url);
  const r = await fetch(s.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(s.key ? { authorization: `Bearer ${s.key}` } : {}) },
    body: JSON.stringify(isOllama ? { model: s.model, prompt: text } : { model: s.model, input: text }),
  });
  if (!r.ok) throw new Error(`эндпоинт эмбеддингов ответил ${r.status}`);
  const j = await r.json();
  const v = j.embedding || j.data?.[0]?.embedding;
  if (!Array.isArray(v)) throw new Error('в ответе нет вектора');
  return normalize(v);
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, x => x / n);
}

/* Полный перебор по кускам — и это нормально. Косинус нормированных векторов —
   это скалярное произведение: 19 000 кусков по 768 измерений это 15 миллионов
   умножений, доли секунды. Приближённые индексы (HNSW и прочие) начинают
   окупаться на сотнях тысяч, а до них личному вальту очень далеко — и платить
   за них сложностью сборки сейчас не за что. */
export async function searchVectors(query, limit = 25) {
  if (!await initVectors()) return [];
  const q = await embedQuery(query);
  const { dim, shards, perShard } = vecState.manifest;
  if (q.length !== dim) throw new Error(`размерность запроса ${q.length}, а в вальте ${dim}`);
  const best = [];
  for (let s = 0; s < shards; s++) {
    const data = await shard(s);
    const rows = Math.floor(data.length / dim);
    for (let r = 0; r < rows; r++) {
      const off = r * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += q[d] * data[off + d];
      best.push([s * perShard + r, dot / 127]);
    }
  }
  best.sort((a, b) => b[1] - a[1]);

  // Из кусков собираем заметки: заметка стоит столько, сколько её лучший кусок.
  // Иначе длинная заметка выигрывает просто числом кусков.
  const seen = new Map();
  for (const [i, score] of best) {
    const c = vecState.chunks[i];
    if (!c) continue;
    if (!seen.has(c.p)) seen.set(c.p, { path: c.p, heading: c.h || null, score, chunk: i });
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

/* Слияние двух списков. Складывать сами оценки нельзя: BM25 даёт единицы и
   десятки, косинус — доли единицы, и любая нормировка одного к другому будет
   подгонкой под конкретный вальт. Reciprocal Rank Fusion складывает не оценки,
   а места: вклад результата равен 1/(k+место), поэтому важно только то, что
   документ высоко в каком-то из списков, а масштаб оценок не важен вовсе.
   k = 60 — значение из исходной работы, оно же общепринятое по умолчанию. */
export function fuseRRF(lists, { k = 60, weights = null, limit = 25 } = {}) {
  const score = new Map();
  const meta = new Map();
  lists.forEach((list, li) => {
    const w = weights?.[li] ?? 1;
    list.forEach((item, rank) => {
      const key = item.path;
      score.set(key, (score.get(key) || 0) + w / (k + rank + 1));
      if (!meta.has(key)) meta.set(key, item);
      else if (item.frag && !meta.get(key).frag) meta.set(key, { ...meta.get(key), frag: item.frag });
    });
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, s]) => ({ ...meta.get(path), path, rrf: +s.toFixed(5) }));
}
