// Похожие заметки и кластеры по смыслу.
//
// Папки отвечают на вопрос «где это лежит», а не «о чём это». В вальте `brain`
// — это и решения, и журнал сессий, и профиль: одна папка, три разных мира.
// Здесь два способа увидеть настоящее устройство корпуса:
//
//   похожие  — по редким словам, которые заметки делят между собой (tf-idf по
//              ключам из карты), плюс общие теги и общие связи;
//   кластеры — по графу связей алгоритмом Лувена: группы, внутри которых
//              ссылок густо, а между которыми редко. Это и есть созвездия по
//              смыслу, в отличие от созвездий по папкам.
//
// Ни то, ни другое не требует ИИ и не стоит ни копейки: всё считается из уже
// собранной карты.
import { corpus, isVisible } from './corpus.js';
import { keywords } from './map.js';
import { translit } from './search.js';

/* ── похожие ──────────────────────────────────────────────────────────────── */

// Кэши привязаны к отметке загрузки корпуса: пришёл новый индекс — счёт заново.
// Так не нужно ничего разинвалидировать руками из main.js и нельзя забыть.
const stamp = () => corpus.loadedAt?.getTime() || 0;
let kwIndex = null;   // термин → [индексы заметок]

async function buildKwIndex() {
  if (kwIndex && kwIndex.at === stamp()) return kwIndex;
  const kws = await keywords();
  const idx = new Map();
  kws.forEach((list, i) => {
    for (const t of list || []) {
      let arr = idx.get(t);
      if (!arr) idx.set(t, (arr = []));
      arr.push(i);
    }
  });
  kwIndex = { idx, kws, at: stamp() };
  return kwIndex;
}

let tagIdx = null;
function tagCounts() {
  if (tagIdx && tagIdx.at === stamp()) return tagIdx.map;
  const map = new Map();
  corpus.notes.forEach((n, i) => { for (const t of n.tags || []) { let a = map.get(t); if (!a) map.set(t, a = []); a.push(i); } });
  tagIdx = { map, at: stamp() };
  return map;
}

export async function similarTo(note, limit = 8) {
  if (!corpus.fromMap) return [];
  const { idx, kws } = await buildKwIndex();
  const notes = corpus.notes;
  const self = notes.indexOf(note);
  if (self < 0) return [];

  const score = new Map();
  const add = (i, w) => { if (i !== self) score.set(i, (score.get(i) || 0) + w); };

  // Общее редкое слово весит больше общего частого: «Sperrkonto» роднит две
  // заметки сильнее, чем «система».
  for (const t of kws[self] || []) {
    const docs = idx.get(t) || [];
    if (docs.length > notes.length / 4) continue;       // слишком общее слово
    const w = 1 / Math.log2(2 + docs.length);
    for (const d of docs) add(d, w);
  }
  /* Общие соседи по графу — сигнал не хуже слов, но считать их поштучно нельзя:
     половина вальта связана с «Главной», и по общему соседу-хабу похожим на всё
     оказывается всё. Мера Адамика–Адара решает это одним делением: вклад общего
     соседа обратен логарифму его степени — общий редкий сосед почти доказывает
     родство, общий хаб не значит ничего. Теги считаются так же: #проект на сорока
     заметках — не родство, #sperrkonto на трёх — родство. */
  const at = new Map(notes.map((n, i) => [n, i]));
  const near = n => [...(n.links || []).map(l => l.to), ...(n.backlinks || []).map(l => l.from)];
  for (const x of near(note)) {
    const w = 1.1 / Math.log2(2 + x.deg);
    for (const y of near(x)) { const i = at.get(y); if (i !== undefined) add(i, w); }
    const xi = at.get(x);
    if (xi !== undefined) add(xi, .8);                   // прямая связь — сильный сигнал сама по себе
  }
  const tagFreq = tagCounts();
  for (const t of note.tags || []) {
    const holders = tagFreq.get(t) || [];
    const w = 1.4 / Math.log2(2 + holders.length);
    for (const i of holders) add(i, w);
  }

  /* Две поправки, без которых список одинаков для всех заметок.

     Журналы и телеграм-срезы упоминают всё подряд — в поиске они уже приглушены
     весом 0.4, здесь та же мера.

     Хабы — «Главная», «Индекс памяти», «Hot» — не хроника, но ведут себя так же:
     они ссылаются на всё и содержат обо всём по строчке, поэтому всплывают в
     похожих у любой заметки. Делим на логарифм степени: заметка с тридцатью
     связями должна доказать сходство втрое убедительнее, чем с тремя. */
  return [...score]
    .map(([i, s]) => [i, (notes[i].zoneRef?.chronicle ? s * .4 : s) / Math.log2(2 + notes[i].deg)])
    .filter(([i]) => isVisible(notes[i]))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([i, s]) => ({ note: notes[i], score: +s.toFixed(2) }));
}

/* ── кластеры (Лувен) ─────────────────────────────────────────────────────────
   Классическая жадная модульность: сначала каждая заметка — свой кластер, затем
   узлы перебрасываются к соседям, пока это увеличивает модульность; потом граф
   сворачивается и всё повторяется. Реализация укладывается в сотню строк и на
   десяти тысячах узлов считается за доли секунды — библиотека тут не нужна. */

let clusters = null;

function labelFor(members, kws, idx, notes) {
  const freq = new Map();
  for (const i of members) for (const t of kws[i] || []) freq.set(t, (freq.get(t) || 0) + 1);
  const cyr = new Set([...freq.keys()].filter(t => /[а-яё]/.test(t)));
  const twins = new Set([...cyr].map(translit));
  const cand = [...freq]
    .filter(([t, n]) => n > 1 && !(twins.has(t) && !cyr.has(t)))
    .map(([t, n]) => [t, n / Math.log2(2 + (idx.get(t)?.length || 1))])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => word(t, members, notes));
  return (cand.join(' · ') || notes[members[0]]?.title || '—').toUpperCase();
}

function word(stem, members, notes) {
  let best = stem;
  for (const i of members) {
    for (const w of (notes[i].title || '').toLowerCase().split(/[^0-9a-zа-яё]+/)) {
      if (w.startsWith(stem) && w.length > best.length) best = w;
    }
  }
  return best;
}

function louvain(nodeCount, edges, passes = 8) {
  let community = Array.from({ length: nodeCount }, (_, i) => i);
  let nodes = nodeCount;
  let links = edges.map(e => ({ a: e.a, b: e.b, w: e.w || 1 }));
  const mapping = Array.from({ length: nodeCount }, (_, i) => i);   // исходный узел → текущий

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

    // Перенумеровать сообщества и свернуть граф.
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
    community = mapping.slice();
    if (nodes <= 1) break;
  }
  return mapping;
}

/* Имя кластеру — по самым характерным словам его заметок: «ЕРЕВАН · ИП · НАЛОГИ»
   читается лучше, чем «кластер 3». Три тонкости, без которых имена выходят
   мусорные:

   характерность, а не частота — слово, встречающееся во всём вальте, ничего не
   говорит об этой группе, поэтому частота внутри делится на распространённость
   снаружи;

   без транслитных двойников — в словаре каждое русское слово лежит и латиницей
   (для поиска вслепую по «vault»), иначе имя выходит вида «МЫСЛ · MYSL»;

   живые слова вместо основ — в словаре лежит «налогов», а показать надо
   «налоговый», поэтому основа разворачивается обратно по заголовкам группы. */
export async function buildClusters() {
  if (clusters && clusters.at === stamp()) return clusters;
  const notes = corpus.notes;
  const idxOf = new Map(notes.map((n, i) => [n, i]));
  const edges = corpus.edges
    .map(e => ({ a: idxOf.get(e.a), b: idxOf.get(e.b), w: e.type === 'link' ? 1 : 1.6 }))
    .filter(e => e.a !== undefined && e.b !== undefined);

  const assign = louvain(notes.length, edges);
  const groups = new Map();
  assign.forEach((c, i) => {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  });

  const { idx, kws } = await buildKwIndex().catch(() => ({ idx: new Map(), kws: [] }));
  const list = [...groups.entries()]
    .map(([id, members]) => ({ id, members, size: members.length, label: labelFor(members, kws, idx, notes) }))
    .sort((a, b) => b.size - a.size);

  /* Лувен работает по связям, а связей в вальте мало: две трети заметок ни на
     что не ссылаются и остаются одиночками. Раскладка, где 70 % карты — «прочее»,
     бесполезна, поэтому одиночек досыпаем по смыслу: каждая идёт в ту группу,
     с чьим словарём у неё больше общего. Что не подошло никуда — честно остаётся
     россыпью, а не приписывается к ближайшей попавшейся. */
  const big = list.filter(c => c.size >= 3);
  const loose = list.filter(c => c.size < 3).flatMap(c => c.members);
  const profile = big.map(c => {
    const p = new Map();
    for (const i of c.members) for (const t of kws[i] || []) p.set(t, (p.get(t) || 0) + 1);
    return p;
  });
  const rest = [];
  for (const i of loose) {
    let best = -1, bs = 0;
    for (let c = 0; c < big.length; c++) {
      let s = 0;
      for (const t of kws[i] || []) {
        const inC = profile[c].get(t); if (!inC) continue;
        s += (inC / big[c].size) / Math.log2(2 + (idx.get(t)?.length || 1));
      }
      if (s > bs) { bs = s; best = c; }
    }
    if (best >= 0 && bs > 0.02) { big[best].members.push(i); big[best].size++; big[best].soft = (big[best].soft || 0) + 1; }
    else rest.push(i);
  }
  big.sort((a, b) => b.size - a.size);
  if (rest.length) big.push({ id: -1, members: rest, size: rest.length, label: 'РОССЫПЬ' });

  const byNote = new Map();
  big.forEach((c, ci) => c.members.forEach(i => byNote.set(notes[i], ci)));
  clusters = { list: big, byNote, at: stamp() };
  return clusters;
}
