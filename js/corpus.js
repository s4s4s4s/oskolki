// Корпус: модель вальта, из которой живут граф, картотека, фильтры и поиск.
//
// Основной источник — карта (`_машина/карта`): лёгкая строка на заметку плюс
// инвертированный словарь. Если карты нет (старый вальт, чужой воркер), корпус
// собирается по-старому из кусков индекса — приложение обязано работать и там,
// просто без тегов, типов и типизированных связей.
import { tools } from './api.js';
import { linksOf, plural } from './md.js';
import { fetchMap, applyMap, mapState, searchMap, noteText } from './map.js';
import {
  INDEX_DIR, SYNONYMS_PATH, ZONE_PALETTE, ZONE_NAMES,
  SPLIT_MIN, SUBZONE_MIN, CHRONICLE_ZONES, CHRONICLE_COLOR, HIDDEN_LAYERS, HIDDEN_ZONES,
} from './config.js';
import { prepareChunks, parseSynonyms, searchChunks } from './search.js';
import { searchVectors, fuseRRF, getEmbedSettings, vecState } from './vectors.js';

export const corpus = {
  notes: [],           // {path, base, title, zone, zoneRef, type, status, tags, meta, out, in, links, backlinks, deg}
  byPath: new Map(),
  byBase: new Map(),
  zones: [],           // {name, label, color, count, on, chronicle}
  edges: [],           // [{a, b, type}]
  layers: [],          // {name, count, on} — тип заметки: note, person, card…
  tagCounts: new Map(),
  linkTypes: {},
  chunks: [],          // только для старой схемы
  synonyms: '',
  loadedAt: null,
  fromCache: null,
  fromMap: false,
};

const baseOf = p => p.replace(/\.md$/i, '').split('/').pop();
export const isChronicle = zone => CHRONICLE_ZONES.some(re => re.test(zone));
export const zoneLabel = zone => ZONE_NAMES[zone] || zone.split('/').pop().toUpperCase();

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
function shade(hex, k) {
  const [r, g, b] = hexToRgb(hex);
  const t = k > 0 ? 255 : 0, a = Math.abs(k);
  return '#' + [r, g, b].map(c => clamp(c + (t - c) * a).toString(16).padStart(2, '0')).join('');
}

/* ── созвездия ────────────────────────────────────────────────────────────── */

export function zoneOfPath(path, splitSet) {
  const parts = path.split('/');
  if (parts.length < 2) return 'корень';
  const l1 = parts[0];
  if (parts.length > 2) {
    const l2 = `${l1}/${parts[1]}`;
    if (splitSet.has(l2)) return l2;
  }
  return l1;
}

function planZones(paths) {
  const byL1 = new Map(), byL2 = new Map();
  for (const p of paths) {
    const parts = p.split('/');
    const l1 = parts.length > 1 ? parts[0] : 'корень';
    byL1.set(l1, (byL1.get(l1) || 0) + 1);
    if (parts.length > 2) {
      const l2 = `${l1}/${parts[1]}`;
      byL2.set(l2, (byL2.get(l2) || 0) + 1);
    }
  }
  const split = new Set();
  for (const [l2, n] of byL2) {
    const l1 = l2.split('/')[0];
    if ((byL1.get(l1) || 0) > SPLIT_MIN && n >= SUBZONE_MIN) split.add(l2);
  }
  return split;
}

function buildZones(notes, prevOn) {
  const split = planZones(notes.map(n => n.path));
  for (const n of notes) n.zone = zoneOfPath(n.path, split);

  const names = [...new Set(notes.map(n => n.zone))].sort((a, b) => a.localeCompare(b, 'ru'));
  const rootColor = new Map();
  let ci = 0;
  for (const name of names) {
    const root = name.split('/')[0];
    if (!rootColor.has(root)) rootColor.set(root, ZONE_PALETTE[ci++ % ZONE_PALETTE.length]);
  }
  const subIndex = new Map();
  return names.map(name => {
    const root = name.split('/')[0];
    const chronicle = isChronicle(name);
    let color = rootColor.get(root);
    if (name.includes('/')) {
      const k = (subIndex.get(root) || 0) + 1;
      subIndex.set(root, k);
      color = shade(color, k % 2 ? 0.22 : -0.24);
    }
    if (chronicle) color = CHRONICLE_COLOR;
    return {
      name, label: zoneLabel(name), color, chronicle,
      count: notes.filter(n => n.zone === name).length,
      on: prevOn.has(name) ? prevOn.get(name) : !HIDDEN_ZONES.includes(name),
    };
  });
}

/* Слои — это `type` из фронтматтера: note, person, task, card, log… Карточки
   SAT (сотни файлов и растут) раньше просто вырезались сборщиком; теперь они в
   карте есть, но слой по умолчанию выключен. Решение «показывать или нет»
   принимает человек, а не сборщик, и передумать можно без пересборки. */
function buildLayers(notes, prevOn) {
  const counts = new Map();
  for (const n of notes) counts.set(n.type || '—', (counts.get(n.type || '—') || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({
    name, count,
    on: prevOn.has(name) ? prevOn.get(name) : !HIDDEN_LAYERS.includes(name),
  }));
}

/* ── модель из карты ──────────────────────────────────────────────────────── */

export function buildFromMap(map) {
  const notes = map.notes.map(n => ({
    path: n.p,
    base: baseOf(n.p),
    title: n.t || baseOf(n.p),
    zone: '',
    type: n.ty || '',
    status: n.st || '',
    tags: n.tg || [],
    headings: n.hd || [],
    broken: n.br || [],
    meta: { u: n.u || null, h: n.h || null, c: n.c || 0, b: n.b || 0 },
    out: [], in: [], links: [], backlinks: [], deg: 0,
  }));

  const byPath = new Map(notes.map(n => [n.path, n]));
  const byBase = new Map();
  for (const n of notes) if (!byBase.has(n.base.toLowerCase())) byBase.set(n.base.toLowerCase(), n);

  const edges = [];
  map.notes.forEach((raw, i) => {
    const from = notes[i];
    for (const [to, type] of raw.ln || []) {
      const target = notes[to];
      if (!target || target === from) continue;
      from.links.push({ to: target, type });
      target.backlinks.push({ from, type });
      from.out.push(target); target.in.push(from);
      from.deg++; target.deg++;
      edges.push({ a: from, b: target, type });
    }
  });

  const prevOn = new Map(corpus.zones.map(z => [z.name, z.on]));
  const prevLayers = new Map(corpus.layers.map(l => [l.name, l.on]));
  const zones = buildZones(notes, prevOn);
  const zmap = new Map(zones.map(z => [z.name, z]));
  for (const n of notes) n.zoneRef = zmap.get(n.zone);

  const tagCounts = new Map(Object.entries(map.tags || {}).sort((a, b) => b[1] - a[1]));

  return {
    notes, byPath, byBase, zones, edges,
    layers: buildLayers(notes, prevLayers),
    tagCounts, linkTypes: map.linkTypes || {},
    chunks: [], fromMap: true,
  };
}

/* ── модель из старого индекса (запасной путь) ────────────────────────────── */

export function buildModel(chunks, meta, synonyms) {
  const byPath = new Map();
  const indexRoot = INDEX_DIR.split('/')[0];
  for (const c of chunks) {
    if (!c.p || c.p.startsWith(indexRoot)) continue;
    let n = byPath.get(c.p);
    if (!n) { n = { path: c.p, base: baseOf(c.p), title: baseOf(c.p), zone: '', type: '', status: '', tags: [], headings: [], broken: [], _chunks: [], links: [], backlinks: [], out: [], in: [], deg: 0 }; byPath.set(c.p, n); }
    n._chunks.push(c);
  }
  const notes = [...byPath.values()];
  for (const n of notes) {
    n._chunks.sort((a, b) => (a.i || 0) - (b.i || 0));
    n.text = n._chunks.map(c => c.t).join('\n\n');
    const m = meta?.[n.path];
    n.meta = { u: m?.u ?? null, h: m?.h ?? null, c: m?.c ?? 0, b: m?.b ?? n.text.length };
    delete n._chunks;
  }
  const byBase = new Map();
  for (const n of notes) byBase.set(n.base.toLowerCase(), n);

  const edges = []; const seen = new Set();
  for (const n of notes) for (const l of linksOf(n.text)) {
    const key = l.target.toLowerCase();
    const t = byBase.get(key) || byPath.get(l.target) || byPath.get(l.target + '.md');
    if (!t || t === n) continue;
    const ek = n.path < t.path ? n.path + '|' + t.path : t.path + '|' + n.path;
    if (seen.has(ek)) continue;
    seen.add(ek);
    edges.push({ a: n, b: t, type: 'link' });
    n.links.push({ to: t, type: 'link' }); t.backlinks.push({ from: n, type: 'link' });
    n.out.push(t); t.in.push(n); n.deg++; t.deg++;
  }

  const prevOn = new Map(corpus.zones.map(z => [z.name, z.on]));
  const zones = buildZones(notes, prevOn);
  const zmap = new Map(zones.map(z => [z.name, z]));
  for (const n of notes) n.zoneRef = zmap.get(n.zone);

  return {
    notes, byPath, byBase, zones, edges,
    layers: buildLayers(notes, new Map()), tagCounts: new Map(), linkTypes: {},
    chunks, synonyms, fromMap: false,
  };
}

/* ── загрузка ─────────────────────────────────────────────────────────────── */

export async function fetchIndex(onStep) {
  // Сначала карта: она на порядок легче и знает про теги, типы и связи.
  try {
    const raw = await fetchMap(onStep);
    return { kind: 'map', ...raw };
  } catch {
    onStep && onStep('карты нет — читаю индекс…');
  }

  const listing = await tools.list(INDEX_DIR);
  const files = listing.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[папка]')).map(l => l.replace(/ \(\d+ б\)$/, ''));
  const shardFiles = files.filter(f => /\/\d+\.json$/.test(f));
  const metaFile = files.find(f => f.endsWith('meta.json'));

  onStep && onStep(`читаю ${shardFiles.length} ${plural(shardFiles.length, 'шард', 'шарда', 'шардов')}…`);
  const texts = [];
  const queue = [...shardFiles];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) { const f = queue.shift(); texts.push(await tools.read(f)); }
  }));
  const json = t => JSON.parse(t.replace(/^﻿/, ''));
  const meta = metaFile ? json(await tools.read(metaFile)) : {};
  const synonyms = await tools.read(SYNONYMS_PATH).catch(() => '');
  return { kind: 'index', chunks: texts.flatMap(json), meta, synonyms, at: new Date().toISOString() };
}

export function applyModel(model, { fromCache = null } = {}) {
  Object.assign(corpus, model, { loadedAt: new Date(), fromCache });
  searchIndex = null;
  return corpus;
}

// Разбор сырых данных в модель — общий для сети и для офлайн-копии.
export function modelFrom(raw) {
  if (raw.kind === 'map' || raw.map) {
    applyMap(raw);
    return buildFromMap(raw.map);
  }
  return buildModel(raw.chunks, raw.meta, raw.synonyms);
}

export async function loadCorpus(onStep) {
  const raw = await fetchIndex(onStep);
  onStep && onStep('собираю граф…');
  return applyModel(modelFrom(raw));
}

export const resolveWiki = target => corpus.byBase.get(target.toLowerCase()) || corpus.byPath.get(target) || corpus.byPath.get(target + '.md') || null;

/* Видимость заметки — пересечение двух фильтров: созвездие (папка) и слой (тип).
   Оба нужны: папки отвечают на «где это лежит», типы — на «что это такое», и
   на десяти тысячах заметок вопросы разные. */
export const layerOn = type => {
  const l = corpus.layers.find(x => x.name === (type || '—'));
  return l ? l.on : true;
};
export const isVisible = n => n.zoneRef?.on !== false && layerOn(n.type);

/* ── поиск ────────────────────────────────────────────────────────────────── */

let searchIndex = null;

// Возвращает {results:[{path,title,frag,rank,coverage}], terms}. На карте это
// чтение нескольких шардов словаря, на старой схеме — перебор кусков в памяти.
export async function searchCorpus(query, limit = 25, { hybrid = true } = {}) {
  const base = await bm25(query, limit);
  if (!hybrid || !getEmbedSettings().on) return base;

  /* Смысловой слой — необязательное слагаемое. Если векторов нет, эндпоинт не
     отвечает или модель разошлась со сборкой, поиск просто остаётся словесным:
     ронять из-за этого выдачу нельзя, а объяснять человеку устройство слоёв на
     каждом запросе — тем более. Ошибка запоминается в vecState и видна в
     настройках, где ей и место. */
  try {
    const vec = await searchVectors(query, limit);
    if (!vec.length) return base;
    const enriched = vec.map(v => {
      const n = corpus.byPath.get(v.path);
      return { path: v.path, title: n?.title || v.path, chain: v.heading || '', rank: v.score, vector: true };
    });
    const results = fuseRRF([base.results, enriched], { limit })
      .map(r => ({ ...r, title: r.title || corpus.byPath.get(r.path)?.title || r.path }));
    return { results, terms: base.terms, hybrid: true };
  } catch (e) {
    vecState.error = e.message;
    return base;
  }
}

async function bm25(query, limit) {
  if (corpus.fromMap) {
    const { results, terms } = await searchMap(query, limit);
    return { results, terms };
  }
  if (!searchIndex || searchIndex.src !== corpus.chunks) {
    searchIndex = {
      src: corpus.chunks,
      chunks: prepareChunks(corpus.chunks),
      synonyms: parseSynonyms(corpus.synonyms),
    };
  }
  return searchChunks(searchIndex.chunks, query, searchIndex.synonyms, limit);
}

export const searchReady = () => corpus.fromMap ? mapState.loaded : !!searchIndex;

// Текст заметки: из карты его нет, читаем сам файл (с кэшем). На старой схеме
// текст уже лежит в модели.
export async function textOf(note, opts) {
  if (!corpus.fromMap && note.text) return note.text;
  return noteText(note.path || note, opts);
}
