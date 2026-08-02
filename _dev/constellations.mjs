/**
 * Созвездия из смысла: проверка идеи «группы возникают сами».
 *
 * Замысел Александра: не писать тематические узлы руками, а дать осколкам
 * собираться в созвездия самим — по явным связям И по векторной близости, чтобы
 * рядом оказывалось то, что про одно и то же, даже если ссылку между ними никто
 * не ставил.
 *
 * Проверить это можно до всякой перестройки базы, прямо на нынешнем вальте:
 * векторы уже собраны, а кластеризация по связям уже написана. Скрипт считает
 * три варианта и печатает их рядом, чтобы разница была видна глазами:
 *
 *   только связи   — то, что есть сейчас: Лувен по графу ссылок;
 *   только смысл   — Лувен по взаимному kNN между векторами;
 *   вместе         — сумма рёбер с весами.
 *
 * Почему взаимный kNN, а не порог по косинусу. Порог даёт кашу: в личном вальте
 * почти всё похоже на почти всё на уровне 0.5–0.6, и граф превращается в единый
 * ком. kNN берёт у каждого осколка k ближайших — и ребро остаётся, только если
 * оба считают друг друга близкими. Это стандартная защита от «магнитов»: заметка
 * вроде «Индекс памяти» похожа на всё подряд, но ни у кого не входит в личный
 * топ-5, и в граф она не втягивает всех.
 *
 * Ничего не меняет. Запуск: node _dev/constellations.mjs [--k 6] [--vault <путь>]
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const VAULT = resolve(flag('vault', 'C:/Users/sasha/Documents/Obsidian Vault'));
const K = Number(flag('k', 6));
const MAP = join(VAULT, '_машина/карта');
const VEC = join(VAULT, '_машина/векторы');

const readJson = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const notes = readJson(join(MAP, 'карта.json')).notes;
const keys = readJson(join(MAP, 'ключи.json'));
const manifest = readJson(join(VEC, 'манифест.json'));
const chunks = readJson(join(VEC, 'куски.json'));

// Векторы кусков → плоский массив: строка i соответствует куску i.
const { dim, shards, perShard } = manifest;
const vecs = new Int8Array(chunks.length * dim);
for (let s = 0; s < shards; s++) {
  const { b64 } = readJson(join(VEC, `${String(s).padStart(3, '0')}.json`));
  const buf = Buffer.from(b64, 'base64');
  vecs.set(new Int8Array(buf.buffer, buf.byteOffset, buf.length), s * perShard * dim);
}

const idxOfPath = new Map(notes.map((n, i) => [n.p, i]));
const chunkNote = chunks.map(c => idxOfPath.get(c.p) ?? -1);

/* Заметка похожа на заметку настолько, насколько похожи их самые близкие куски.
   Складывать все пары нельзя: длинная заметка выиграет числом кусков, а не
   содержанием. */
console.log(`Кусков ${chunks.length}, заметок ${notes.length}, ${dim} измерений. Считаю ближайших…`);
const t0 = Date.now();

/* Вычитание общего направления.

   Сырой косинус на личном вальте меряет не только смысл, но и форму: ночные
   логи написаны по одному шаблону одними оборотами, и модель считает их
   близнецами с косинусом 1.00, хотя содержание в них разное. Это известная
   болезнь эмбеддингов — у корпуса есть «общее направление», в которое смотрят
   все векторы сразу, и оно съедает различия.

   Лечится вычитанием среднего вектора корпуса: остаётся то, чем документ
   отличается от типичного текста этого вальта, а не то, чем он на него похож.
   Считается один раз и стоит копейки. */
const centered = new Float32Array(chunks.length * dim);
{
  const mean = new Float64Array(dim);
  for (let i = 0; i < chunks.length; i++) for (let d = 0; d < dim; d++) mean[d] += vecs[i * dim + d];
  for (let d = 0; d < dim; d++) mean[d] /= chunks.length;
  for (let i = 0; i < chunks.length; i++) {
    let n = 0;
    for (let d = 0; d < dim; d++) { const v = vecs[i * dim + d] - mean[d]; centered[i * dim + d] = v; n += v * v; }
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < dim; d++) centered[i * dim + d] /= n;
  }
}
const RAW = args.includes('--raw');
const cos = (a, b) => {
  let dot = 0;
  const x = a * dim, y = b * dim;
  if (RAW) { for (let d = 0; d < dim; d++) dot += vecs[x + d] * vecs[y + d]; return dot / (127 * 127); }
  for (let d = 0; d < dim; d++) dot += centered[x + d] * centered[y + d];
  return dot;
};

// Для каждого куска — k ближайших чужих кусков (свои куски одной заметки пропускаем).
const near = [];
for (let i = 0; i < chunks.length; i++) {
  const mine = chunkNote[i];
  const top = [];
  for (let j = 0; j < chunks.length; j++) {
    if (j === i || chunkNote[j] === mine || chunkNote[j] < 0) continue;
    const s = cos(i, j);
    if (top.length < K) { top.push([j, s]); top.sort((a, b) => b[1] - a[1]); }
    else if (s > top[K - 1][1]) { top[K - 1] = [j, s]; top.sort((a, b) => b[1] - a[1]); }
  }
  near.push(top);
}
console.log(`Ближайшие посчитаны за ${((Date.now() - t0) / 1000).toFixed(1)} с.`);

// Взаимность: ребро остаётся, если оба куска считают друг друга близкими.
const mutual = new Map();
const inTop = near.map(t => new Set(t.map(x => x[0])));
for (let i = 0; i < chunks.length; i++) {
  for (const [j, s] of near[i]) {
    if (!inTop[j].has(i)) continue;
    const a = chunkNote[i], b = chunkNote[j];
    if (a < 0 || b < 0 || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    mutual.set(key, Math.max(mutual.get(key) || 0, s));   // заметки роднит их лучшая пара кусков
  }
}
console.log(`Взаимных смысловых рёбер между заметками: ${mutual.size}\n`);

/* ── Лувен (та же реализация, что в приложении) ───────────────────────────── */
function louvain(nodeCount, edges, passes = 8) {
  let nodes = nodeCount;
  let links = edges.map(e => ({ a: e.a, b: e.b, w: e.w || 1 }));
  const mapping = Array.from({ length: nodeCount }, (_, i) => i);
  for (let pass = 0; pass < passes; pass++) {
    const adj = Array.from({ length: nodes }, () => new Map());
    const deg = new Array(nodes).fill(0);
    let m2 = 0;
    for (const { a, b, w } of links) {
      if (a === b) { deg[a] += 2 * w; m2 += 2 * w; continue; }
      adj[a].set(b, (adj[a].get(b) || 0) + w);
      adj[b].set(a, (adj[b].get(a) || 0) + w);
      deg[a] += w; deg[b] += w; m2 += 2 * w;
    }
    if (!m2) break;
    const comm = Array.from({ length: nodes }, (_, i) => i);
    const commDeg = deg.slice();
    let moved = false;
    for (let round = 0; round < 6; round++) {
      let changed = 0;
      for (let i = 0; i < nodes; i++) {
        const my = comm[i];
        commDeg[my] -= deg[i];
        const gains = new Map();
        for (const [j, w] of adj[i]) gains.set(comm[j], (gains.get(comm[j]) || 0) + w);
        let best = my, bestGain = (gains.get(my) || 0) - commDeg[my] * deg[i] / m2;
        for (const [c, w] of gains) {
          const gain = w - commDeg[c] * deg[i] / m2;
          if (gain > bestGain + 1e-9) { bestGain = gain; best = c; }
        }
        commDeg[best] += deg[i];
        if (best !== my) { comm[i] = best; changed++; moved = true; }
      }
      if (!changed) break;
    }
    if (!moved) break;
    const renum = new Map();
    for (let i = 0; i < nodes; i++) if (!renum.has(comm[i])) renum.set(comm[i], renum.size);
    const next = comm.map(c => renum.get(c));
    for (let i = 0; i < nodeCount; i++) mapping[i] = next[mapping[i]];
    const merged = new Map();
    for (const { a, b, w } of links) {
      const x = next[a], y = next[b];
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      merged.set(key, (merged.get(key) || 0) + w);
    }
    links = [...merged].map(([key, w]) => { const [a, b] = key.split('|').map(Number); return { a, b, w }; });
    nodes = renum.size;
    if (nodes <= 1) break;
  }
  return mapping;
}

const linkEdges = [];
notes.forEach((n, i) => (n.ln || []).forEach(([to, type]) => {
  if (to !== i) linkEdges.push({ a: i, b: to, w: type && type !== 'link' ? 1.6 : 1 });
}));
const vecEdges = [...mutual].map(([key, s]) => {
  const [a, b] = key.split('|').map(Number);
  return { a, b, w: s };       // вес — сам косинус: дальняя пара тянет слабее
});

const label = members => {
  const freq = new Map();
  for (const i of members) for (const t of keys[i] || []) if (/[а-яё]/.test(t)) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).join(' · ').toUpperCase() || '—';
};

// Карточки словаря к смыслу вальта отношения не имеют — считаем без них.
const skip = new Set(notes.map((n, i) => (/^Учёба\/Карточки\//.test(n.p) || n.ty === 'card') ? i : -1).filter(i => i >= 0));
const keepEdge = e => !skip.has(e.a) && !skip.has(e.b);

function report(name, edges) {
  const assign = louvain(notes.length, edges.filter(keepEdge));
  const groups = new Map();
  assign.forEach((c, i) => {
    if (skip.has(i)) return;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  });
  const list = [...groups.values()].filter(m => m.length >= 3).sort((a, b) => b.length - a.length);
  const inGroups = list.reduce((a, m) => a + m.length, 0);
  const alone = notes.length - skip.size - inGroups;
  console.log(`\n=== ${name} ===`);
  console.log(`созвездий ${list.length}, в них ${inGroups} заметок, вне групп ${alone}`);
  for (const m of list.slice(0, 9)) {
    console.log(`  ${String(m.length).padStart(3)}  ${label(m)}`);
    console.log(`       ${m.slice(0, 4).map(i => notes[i].t).join(' · ')}${m.length > 4 ? ' …' : ''}`);
  }
  return { list, assign };
}

report('только связи', linkEdges);
report('только смысл (взаимный kNN)', vecEdges);
report('связи + смысл', [...linkEdges, ...vecEdges.map(e => ({ ...e, w: e.w * 1.2 }))]);

/* Что именно добавил смысл: пары, которые векторы считают роднёй, а ссылки между
   ними нет вовсе. Это и есть ответ на вопрос, ради которого всё затевалось. */
const linked = new Set(linkEdges.map(e => (e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`)));
const found = [...mutual].filter(([k]) => !linked.has(k)).sort((a, b) => b[1] - a[1]);
console.log(`\n=== родство без единой ссылки: ${found.length} пар ===`);
for (const [k, s] of found.slice(0, 15)) {
  const [a, b] = k.split('|').map(Number);
  if (skip.has(a) || skip.has(b)) continue;
  console.log(`  ${s.toFixed(2)}  ${notes[a].t}  ⟷  ${notes[b].t}`);
}
console.log('');
