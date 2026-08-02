// Язык запросов: `tag:ереван type:task -is:done after:2026-06 links:>3 "точная фраза"`.
//
// На двух сотнях заметок хватает поиска по словам. На десяти тысячах вопрос
// звучит иначе: «задачи по переезду, не закрытые, тронутые этим летом». Слова
// такое не выражают — нужны фильтры по свойствам, которые и так лежат в карте.
//
// Синтаксис намеренно тот же, что у почты и трекеров: `ключ:значение`, минус
// впереди отрицает, кавычки означают точную фразу. Всё, что не разобрано как
// фильтр, остаётся обычными словами для поиска.
import { corpus } from './corpus.js';

export const FIELDS = {
  tag: 'тег (учитывает вложенные: tag:проект найдёт проект/ереван)',
  класс: 'класс памяти: сущность, утверждение, событие, улика, выводимое',
  вид: 'вид внутри класса: человек, проект, факт, решение, правило, журнал…',
  о: 'утверждения о сущности: о:Ксюша, о:pbcheck',
  type: 'тип заметки: note, person, task, daily, log, card…',
  zone: 'папка: brain, people, projects…',
  status: 'статус из фронтматтера: active, done…',
  path: 'часть пути',
  links: 'число связей: links:>5, links:0',
  size: 'размер в килобайтах: size:>20',
  after: 'правка позже даты: after:2026-06 или after:2026-06-15',
  before: 'правка раньше даты',
  is: 'orphan (никто не ссылается), broken (есть битые ссылки), tagged, untagged, chronicle',
};

const CMP = /^(>=|<=|>|<)?(.+)$/;

export function parseQuery(input) {
  const filters = [];
  const words = [];
  const phrases = [];
  const re = /"([^"]+)"|(-?)([a-zA-Zа-яё_]+):([^\s]+)|(\S+)/gi;
  let m;
  while ((m = re.exec(input || ''))) {
    if (m[1]) { phrases.push(m[1].toLowerCase()); continue; }
    if (m[3] && FIELDS[m[3].toLowerCase()]) {
      filters.push({ key: m[3].toLowerCase(), raw: m[4], neg: m[2] === '-' });
      continue;
    }
    const w = m[5] || (m[3] ? `${m[3]}:${m[4]}` : '');
    if (w) words.push(w);
  }
  return { filters, phrases, text: words.join(' '), raw: input };
}

const dateOf = s => {
  const t = Date.parse(/^\d{4}$/.test(s) ? `${s}-01-01` : /^\d{4}-\d{2}$/.test(s) ? `${s}-01` : s);
  return Number.isNaN(t) ? null : t;
};

const cmpNum = (value, raw) => {
  const [, op, num] = raw.match(CMP);
  const n = parseFloat(num);
  if (Number.isNaN(n)) return false;
  switch (op) {
    case '>': return value > n;
    case '<': return value < n;
    case '>=': return value >= n;
    case '<=': return value <= n;
    default: return value === n;
  }
};

function matchOne(note, f) {
  const v = f.raw.toLowerCase();
  switch (f.key) {
    case 'tag': return (note.tags || []).some(t => t === v || t.startsWith(v + '/'));
    case 'класс': return (note.klass || '').toLowerCase() === v;
    case 'вид': return (note.kind || '').toLowerCase() === v;
    // «о» ищет по обе стороны связи: и утверждения про сущность, и сущность,
    // про которую есть утверждения, — спрашивают и так, и так.
    case 'о': return (note.links || []).some(l => l.type === 'about' && l.to.title.toLowerCase().includes(v))
      || (note.backlinks || []).some(l => l.type === 'about' && l.from.title.toLowerCase().includes(v));
    case 'type': return (note.type || '').toLowerCase() === v;
    case 'zone': return (note.zone || '').toLowerCase().includes(v);
    case 'status': return (note.status || '').toLowerCase() === v;
    case 'path': return note.path.toLowerCase().includes(v);
    case 'links': return cmpNum(note.deg, f.raw);
    case 'size': return cmpNum((note.meta.b || 0) / 1024, f.raw);
    case 'after': { const d = dateOf(f.raw); const h = Date.parse(note.meta.h || note.meta.u || 0); return d != null && h >= d; }
    case 'before': { const d = dateOf(f.raw); const h = Date.parse(note.meta.h || note.meta.u || 0); return d != null && h <= d; }
    case 'is':
      switch (v) {
        case 'orphan': return (note.backlinks || []).length === 0;
        case 'broken': return (note.broken || []).length > 0;
        case 'tagged': return (note.tags || []).length > 0;
        case 'untagged': return (note.tags || []).length === 0;
        case 'chronicle': return !!note.zoneRef?.chronicle;
        default: return (note.status || '').toLowerCase() === v;
      }
    default: return true;
  }
}

export const matches = (note, q) =>
  q.filters.every(f => (f.neg ? !matchOne(note, f) : matchOne(note, f)));

// Фразы проверяются по тексту заметки, поэтому требуют чтения файла — их
// применяем последними и только к тому, что уже прошло остальные фильтры.
export const hasFilters = q => q.filters.length > 0;

export function filterNotes(q, list = corpus.notes) {
  return list.filter(n => matches(n, q));
}

// Подсказка при вводе: какие ключи вообще есть и что уже введено.
export const describe = q => {
  const parts = q.filters.map(f => `${f.neg ? '−' : ''}${f.key}:${f.raw}`);
  if (q.phrases.length) parts.push(...q.phrases.map(p => `«${p}»`));
  if (q.text) parts.push(`слова: ${q.text}`);
  return parts.join(' · ');
};
