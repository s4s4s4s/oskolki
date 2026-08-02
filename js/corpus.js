// Корпус: шарды индекса + meta.json → модель графа (заметки, связи, созвездия).
// Здесь же живёт разбиение на зоны и подготовка данных для локального поиска.
import { tools } from './api.js';
import { linksOf, plural } from './md.js';
import { prepareChunks, parseSynonyms, searchChunks } from './search.js';
import {
  INDEX_DIR, SYNONYMS_PATH, ZONE_PALETTE, ZONE_NAMES,
  SPLIT_MIN, SUBZONE_MIN, CHRONICLE_ZONES, CHRONICLE_COLOR,
} from './config.js';

export const corpus = {
  notes: [],           // {path, base, title, zone, zoneRef, text, chains, meta:{u,h,c,b}, out:[], in:[], deg}
  byPath: new Map(),
  byBase: new Map(),   // нижний регистр короткого имени → note
  zones: [],           // {name, label, color, count, on, chronicle}
  edges: [],           // [{a, b}] — объекты заметок
  chunks: [],          // сырые куски индекса {p,h,t,i} — основа локального поиска
  synonyms: '',        // текст _машина/синонимы.md, если удалось прочитать
  loadedAt: null,
  fromCache: null,     // ISO-время сборки, если корпус поднят из офлайн-копии
};

const baseOf = p => p.replace(/\.md$/i, '').split('/').pop();
export const isChronicle = zone => CHRONICLE_ZONES.some(re => re.test(zone));
export const zoneLabel = zone => ZONE_NAMES[zone] || zone.split('/').pop().toUpperCase();

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
// Оттенок подзоны: тот же цвет, чуть светлее или темнее — созвездия одной папки
// читаются как семья, но не сливаются в одно пятно.
function shade(hex, k) {
  const [r, g, b] = hexToRgb(hex);
  const t = k > 0 ? 255 : 0, a = Math.abs(k);
  return '#' + [r, g, b].map(c => clamp(c + (t - c) * a).toString(16).padStart(2, '0')).join('');
}

/* ── созвездия ────────────────────────────────────────────────────────────────
   Папка первого уровня — созвездие. Если она крупная (SPLIT_MIN), её подпапки
   от SUBZONE_MIN узлов отделяются в свои созвездия, остальное остаётся в
   родительском. Так `brain` (70 заметок, треть корпуса) распадается на МОЗГ и
   ЖУРНАЛ, а мелкие папки не дробятся в пыль. */
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
      on: prevOn.has(name) ? prevOn.get(name) : true,
    };
  });
}

/* ── модель ───────────────────────────────────────────────────────────────── */

// Разбор сырых кусков индекса в модель. Вынесено отдельно: этим же путём корпус
// поднимается из офлайн-копии, без единого сетевого запроса.
export function buildModel(chunks, meta, synonyms) {
  const byPath = new Map();
  const indexRoot = INDEX_DIR.split('/')[0];
  for (const c of chunks) {
    if (!c.p || c.p.startsWith(indexRoot)) continue;
    let n = byPath.get(c.p);
    if (!n) { n = { path: c.p, base: baseOf(c.p), title: baseOf(c.p), zone: '', _chunks: [], chains: [], out: [], in: [], deg: 0 }; byPath.set(c.p, n); }
    n._chunks.push(c);
  }
  const notes = [...byPath.values()];
  for (const n of notes) {
    n._chunks.sort((a, b) => (a.i || 0) - (b.i || 0));
    n.text = n._chunks.map(c => c.t).join('\n\n');
    n.chains = n._chunks.map(c => c.h || []);
    // Мета может прийти пустой: индекс, собранный старым сборщиком, терял
    // вложенные поля. Приложение не должно из-за этого показывать NaN — размер
    // берём из текста, остальное честно оставляем пустым.
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
    edges.push({ a: n, b: t });
    n.out.push(t); t.in.push(n); n.deg++; t.deg++;
  }

  const prevOn = new Map(corpus.zones.map(z => [z.name, z.on]));
  const zones = buildZones(notes, prevOn);
  const zmap = new Map(zones.map(z => [z.name, z]));
  for (const n of notes) n.zoneRef = zmap.get(n.zone);

  return { notes, byPath, byBase, zones, edges, chunks, synonyms };
}

/* ── загрузка ─────────────────────────────────────────────────────────────── */

// Сырые данные индекса отдельным шагом — их же кладём в офлайн-копию.
export async function fetchIndex(onStep) {
  onStep && onStep('читаю список шардов…');
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
  const meta = metaFile ? JSON.parse(await tools.read(metaFile)) : {};
  // Словарь синонимов необязателен: без него локальный поиск просто не сводит
  // разные корни («лечу» и «переезд»), всё остальное работает.
  const synonyms = await tools.read(SYNONYMS_PATH).catch(() => '');

  const chunks = texts.flatMap(t => JSON.parse(t));
  return { chunks, meta, synonyms, at: new Date().toISOString() };
}

export function applyModel(model, { fromCache = null } = {}) {
  Object.assign(corpus, model, { loadedAt: new Date(), fromCache });
  return corpus;
}

export async function loadCorpus(onStep) {
  const raw = await fetchIndex(onStep);
  onStep && onStep('собираю граф…');
  return applyModel(buildModel(raw.chunks, raw.meta, raw.synonyms));
}

export const resolveWiki = target => corpus.byBase.get(target.toLowerCase()) || corpus.byPath.get(target) || corpus.byPath.get(target + '.md') || null;

/* ── локальный поиск ──────────────────────────────────────────────────────────
   Основы слов считаются один раз на корпус и переживают перерисовки экрана;
   пересчёт только когда пришёл новый индекс. На 1650 кусках подготовка занимает
   десятки миллисекунд, поэтому делать её заранее на старте незачем — первый
   поиск оплатит её сам. */
let searchIndex = null;

export function searchCorpus(query, limit = 25) {
  if (!searchIndex || searchIndex.src !== corpus.chunks) {
    searchIndex = {
      src: corpus.chunks,
      chunks: prepareChunks(corpus.chunks),
      synonyms: parseSynonyms(corpus.synonyms),
    };
  }
  return searchChunks(searchIndex.chunks, query, searchIndex.synonyms, limit);
}

export const searchReady = () => !!searchIndex;
