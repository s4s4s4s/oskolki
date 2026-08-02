// Чтение и правка фронтматтера — того самого блока между `---` в начале заметки,
// где живут тип, статус, теги и типизированные связи.
//
// Это не полноценный YAML и не должен им быть: в вальте встречаются скаляры,
// плоские списки и wikilinks, а тащить парсер ради этого — лишняя зависимость
// в контуре, который должен работать и в браузере, и в Electron, и в Action.
// Зато порядок ключей и незнакомые поля сохраняются как есть: приложение правит
// две строки, а не переписывает чужую разметку по своему вкусу.

export const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFm(text) {
  const m = text.match(FM_RE);
  if (!m) return { fm: {}, order: [], body: text, head: '', hasFm: false };
  const fm = {}, order = [];
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-zА-Яа-я_][\wЀ-ӿ-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      if (!order.includes(key)) order.push(key);
      const v = kv[2].trim();
      if (!v) { fm[key] = []; continue; }
      if (v.startsWith('[') && v.endsWith(']')) {
        fm[key] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
      } else fm[key] = unquote(v);
      continue;
    }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && key) {
      if (!Array.isArray(fm[key])) fm[key] = fm[key] ? [fm[key]] : [];
      fm[key].push(unquote(li[1]));
    }
  }
  return { fm, order, body: text.slice(m[0].length), head: m[1], hasFm: true };
}

const unquote = s => String(s).trim().replace(/^["']|["']$/g, '').trim();

/* Кавычки ставим только там, где без них YAML сломается: лишние кавычки в чужом
   фронтматтере выглядят как чужая правка и раздражают в диффах.

   Wikilink — обязательное исключение. Без кавычек `depends_on: [[[Заметка]]]`
   читается как массив в массиве в массиве, и ни Obsidian, ни Dataview ссылки
   там не видят. Правильная запись — `depends_on: ["[[Заметка]]"]`. */
const quote = v => {
  const s = String(v);
  if (/^\[\[.*\]\]$/.test(s)) return `"${s}"`;
  return /^[\wЀ-ӿ][\wЀ-ӿ \-./+()]*$/.test(s) ? s : `"${s.replace(/"/g, "'")}"`;
};

export function stringifyFm(fm, order = []) {
  const keys = [...order.filter(k => k in fm), ...Object.keys(fm).filter(k => !order.includes(k))];
  const lines = [];
  for (const k of keys) {
    const v = fm[k];
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(quote).join(', ')}]`);
    else if (v == null || v === '') lines.push(`${k}: `);
    else lines.push(`${k}: ${quote(v)}`);
  }
  return lines.join('\n');
}

// Собираем файл обратно. Если фронтматтера не было — заводим его: без него
// заметке некуда положить теги и связи.
export function applyFm(text, fm, order) {
  const parsed = parseFm(text);
  const head = stringifyFm(fm, order.length ? order : parsed.order);
  return `---\n${head}\n---\n\n${parsed.body.replace(/^\s+/, '')}`;
}

export function editFm(text, updater) {
  const { fm, order } = parseFm(text);
  const next = { ...fm };
  updater(next);
  return applyFm(text, next, order);
}

/* ── теги ─────────────────────────────────────────────────────────────────── */

export const normTag = t => String(t).trim().replace(/^#/, '').toLowerCase();

export const fmTags = fm => {
  const v = fm.tags ?? fm.tag ?? fm.теги;
  if (Array.isArray(v)) return v.map(normTag).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,\s]+/).map(normTag).filter(Boolean);
  return [];
};

export const addTag = (text, tag) => editFm(text, fm => {
  const cur = fmTags(fm);
  const t = normTag(tag);
  if (!t || cur.includes(t)) return;
  fm.tags = [...cur, t];
  delete fm.tag; delete fm.теги;      // сводим к одному ключу, чтобы не двоилось
});

export const removeTag = (text, tag) => editFm(text, fm => {
  const t = normTag(tag);
  fm.tags = fmTags(fm).filter(x => x !== t);
  delete fm.tag; delete fm.теги;
});

/* ── типизированные связи ─────────────────────────────────────────────────────
   Ключи те же, что понимает Dataview, — вальт не должен становиться заложником
   этого приложения: связи, поставленные здесь, видны в Obsidian, и наоборот. */
export const LINK_TYPES = [
  { key: 'relates', label: 'СВЯЗАНО', hint: 'просто рядом по смыслу' },
  { key: 'depends_on', label: 'ЗАВИСИТ ОТ', hint: 'без этого не сдвинется' },
  { key: 'blocks', label: 'БЛОКИРУЕТ', hint: 'мешает другому' },
  { key: 'part_of', label: 'ЧАСТЬ', hint: 'входит в состав' },
  { key: 'supersedes', label: 'ЗАМЕНЯЕТ', hint: 'делает прежнее устаревшим' },
  { key: 'source', label: 'ИСТОЧНИК', hint: 'откуда это взялось' },
  { key: 'contradicts', label: 'ПРОТИВОРЕЧИТ', hint: 'спорит с этим' },
  // Несущая связь новой схемы: утверждение вешается на сущности, о которых оно.
  { key: 'about', label: 'О КОМ / О ЧЁМ', hint: 'сущности, к которым крепится утверждение' },
];
// Как эти поля названы в карте (сборщик сводит синонимы к одному имени).
export const TYPE_OF_FIELD = {
  relates: 'relates', depends_on: 'depends', blocks: 'blocks',
  part_of: 'part_of', supersedes: 'supersedes', source: 'source', contradicts: 'contradicts',
  about: 'about',
};
export const FIELD_OF_TYPE = Object.fromEntries(Object.entries(TYPE_OF_FIELD).map(([f, t]) => [t, f]));

const asList = v => Array.isArray(v) ? v : v ? [v] : [];
const wikiOf = name => `[[${String(name).replace(/\.md$/i, '')}]]`;
const sameLink = (a, b) => normLink(a) === normLink(b);
const normLink = s => String(s).replace(/\[\[|\]\]/g, '').split('|')[0].split('#')[0].trim().toLowerCase();

export const addLink = (text, field, target) => editFm(text, fm => {
  const cur = asList(fm[field]);
  if (cur.some(x => sameLink(x, target))) return;
  fm[field] = [...cur, wikiOf(target)];
});

export const removeLink = (text, field, target) => editFm(text, fm => {
  const cur = asList(fm[field]).filter(x => !sameLink(x, target));
  if (cur.length) fm[field] = cur; else delete fm[field];
});

export const setField = (text, key, value) => editFm(text, fm => {
  if (value === null || value === '') delete fm[key]; else fm[key] = value;
});
