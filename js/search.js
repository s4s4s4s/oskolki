// Поиск по корпусу на клиенте — ПОРТ логики vault-mcp/worker.js один в один.
//
// Зачем порт, а не только серверный vault_search: корпус (шарды индекса) и так
// целиком лежит в памяти приложения — значит поиск может отвечать мгновенно и
// работать офлайн. Но две реализации ранжирования расходятся молча, и тогда
// приложение перестаёт находить то, что находит Claude через MCP. Поэтому здесь
// не «свой» поиск, а копия: стеммер, стоп-слова, транслитерация, веса, авторитет
// источника, формула ранга и вырезка фрагмента — те же самые.
//
// Правило: правится worker.js — правится и этот файл (и наоборот). Расхождение
// проверяется на dev-стенде (_dev/server.mjs использует ЭТОТ модуль как поиск).

const SUFFIXES = [
  'ившийся', 'ывшийся', 'авшийся', 'ившись', 'ывшись', 'авшись', 'нуться',
  'ующий', 'ающий', 'ившие', 'ывать', 'ивать', 'овать', 'ается', 'яется',
  'ались', 'ялись', 'ились', 'ешься', 'ишься', 'ческий', 'ически',
  'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ами', 'ями', 'ать', 'ять',
  'ить', 'еть', 'уть', 'ыть', 'ется', 'ются', 'ится', 'атся',
  'ете', 'ите', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ой', 'ей', 'ом',
  'ем', 'им', 'ам', 'ям', 'ах', 'ях', 'ых', 'их', 'ов', 'ев', 'ью',
  'ья', 'ье', 'ий', 'ый', 'ла', 'ло', 'ли', 'ет', 'ит', 'ут', 'ют',
  'ат', 'ят', 'ing', 'ed', 'es',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'л', 's',
];

const STOP = new Set(
  ('я ты он она оно мы вы они это этот эта эти тот та те что чего чем как какой какая какие ' +
   'где когда куда откуда зачем почему кто кого кому не ни да нет и а но или же ли бы был была ' +
   'было были быть есть еще уже вот там тут здесь очень вообще просто надо нужен нужно нужна ' +
   'нужны можно у в во на с со к ко по за из от до для о об про при над под без через между ' +
   'мой моя мои меня мне свой себя весь вся все так то ну вроде типа хочу хотел ' +
   'the a an of to in on for is are was were do does did i my me it this that').split(' ')
);

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya',
};

function translit(w) { let out = ''; for (const ch of w) out += TRANSLIT[ch] ?? ch; return out; }

function stripSuffix(w) {
  for (const s of SUFFIXES) if (w.length - s.length >= 4 && w.endsWith(s)) return w.slice(0, w.length - s.length);
  return w;
}
// два прохода: «налоговый» → «налогов» → «налог»
export const stem = word => stripSuffix(stripSuffix(word.toLowerCase().replace(/ё/g, 'е')));

export function keysOf(word) {
  const s = stem(word);
  const t = translit(s);
  return t !== s ? [s, t] : [s];
}

export function stems(text) {
  const out = new Set();
  for (const w of text.toLowerCase().split(/[^0-9a-zа-яё]+/)) {
    if (w.length < 2 || STOP.has(w)) continue;
    for (const k of keysOf(w)) out.add(k);
  }
  return out;
}

// Словарь синонимов вальта (`_машина/синонимы.md`): одна строка списка — одна группа.
export function parseSynonyms(text) {
  const groups = [];
  for (const raw of (text || '').split('\n')) {
    const m = raw.match(/^\s*[-*]\s+(.*)$/);
    if (!m) continue;
    const words = m[1].split(/[,;·]/).map(w => w.trim()).filter(Boolean);
    if (words.length < 2) continue;
    groups.push(new Set(words.flatMap(keysOf)));
  }
  return groups;
}

export function queryTerms(text, synonyms = []) {
  const terms = [];
  for (const w of text.toLowerCase().split(/[^0-9a-zа-яё]+/)) {
    if (w.length < 2 || STOP.has(w)) continue;
    const keys = new Set(keysOf(w));
    for (const g of synonyms) {
      for (const k of keys) { if (g.has(k)) { for (const s of g) keys.add(s); break; } }
    }
    terms.push([...keys]);
  }
  return terms;
}

export function stemsMatch(a, b) {
  if (a === b) return 1;
  const n = Math.min(6, a.length, b.length);
  if (n >= 4 && a.slice(0, n) === b.slice(0, n)) return 0.7;
  return 0;
}

const W_BODY = 1.0;
const W_META = 1.35;

// Авторитет источника: журналы и очередь упоминают всё подряд и топят заметки,
// которые теме посвящены. Замер: 53% → 70% в топ-5.
const AUTHORITY = [
  [/^brain\/log\//i, 0.4],
  [/^_tools\/queue\//i, 0.4],
  [/^Учёба\/Лог сессий\//i, 0.4],
  [/^daily\//i, 0.7],
  [/^resources\//i, 0.85],
];
export function authority(path) {
  for (const [re, w] of AUTHORITY) if (re.test(path)) return w;
  return 1;
}

export function scoreChunk(chunk, terms) {
  let hits = 0, score = 0;
  for (const term of terms) {
    let best = 0;
    for (const variant of term) {
      for (const k of chunk.meta) { const m = stemsMatch(variant, k) * W_META; if (m > best) best = m; }
      for (const k of chunk.body) { const m = stemsMatch(variant, k) * W_BODY; if (m > best) best = m; }
    }
    if (best > 0) hits++;
    score += best;
  }
  if (!hits) return null;
  const coverage = hits / terms.length;
  return { score: score * coverage * coverage, coverage, hits };
}

export function rankFiles(chunks, query, synonyms, limit) {
  const terms = queryTerms(query, synonyms);
  if (!terms.length) return { files: [], terms };
  const byFile = new Map();
  for (const c of chunks) {
    const s = scoreChunk(c, terms);
    if (!s) continue;
    const cur = byFile.get(c.p);
    if (!cur) byFile.set(c.p, { p: c.p, best: { ...s, c }, n: 1 });
    else { cur.n++; if (s.score > cur.best.score) cur.best = { ...s, c }; }
  }
  const files = [...byFile.values()]
    .map(f => ({ ...f, rank: (f.best.score + Math.log1p(f.n - 1) * 0.35) * authority(f.p) }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
  return { files, terms };
}

export function excerpt(text, terms, span = 320) {
  const words = text.split(/(\s+)/);
  let at = -1;
  outer: for (let i = 0; i < words.length; i++) {
    const w = words[i].toLowerCase().replace(/[^0-9a-zа-яё]/g, '');
    if (w.length < 2) continue;
    const ks = keysOf(w);
    for (const term of terms) for (const v of term) for (const k of ks) if (stemsMatch(v, k)) { at = i; break outer; }
  }
  if (at === -1) return text.slice(0, span).trim() + (text.length > span ? '…' : '');
  let start = 0, len = 0;
  for (let i = at; i >= 0; i--) { len += words[i].length; if (len > span / 2) { start = i; break; } }
  let acc = '';
  for (let i = start; i < words.length && acc.length < span; i++) acc += words[i];
  const head = start > 0 ? '…' : '';
  const tail = start + acc.length < text.length ? '…' : '';
  return `${head}${acc.trim()}${tail}`;
}

/* ── подготовка индекса и поиск в приложении ─────────────────────────────── */

// Основы считаются один раз на корпус (≈1700 кусков — десятки миллисекунд).
// Кладём их рядом с кусками, как это делает воркер при загрузке индекса.
export function prepareChunks(rawChunks) {
  return rawChunks.map(c => {
    const head = (c.h || []).join(' ');
    return { p: c.p, h: c.h || [], t: c.t, i: c.i, body: stems(c.t), meta: stems(`${head} ${c.p}`) };
  });
}

// Локальный поиск. Формат результата — уже разобранный, без сериализации в текст:
// {path, chain, frag, rank, hits, coverage, more}
export function searchChunks(chunks, query, synonyms, limit = 20) {
  const { files, terms } = rankFiles(chunks, query, synonyms, limit);
  return {
    terms,
    results: files.map(({ p, best, n, rank }) => ({
      path: p,
      chain: best.c.h.length ? best.c.h.join(' › ') : '',
      frag: excerpt(best.c.t, terms),
      rank, hits: best.hits, coverage: best.coverage,
      more: n - 1,
    })),
  };
}

/* Разбор выдачи серверного vault_search.

   Формат: блоки «**путь** › цепочка  (ещё N фрагмента)\nфрагмент», разделённые
   пустой строкой, плюс служебная подсказка в конце. Делить весь текст по пустым
   строкам нельзя: фрагмент многострочный и пустые строки внутри него обычное
   дело — так один результат разваливался на два. Опорой служит начало блока:
   строка после пустой, в которой жирным выделен путь файла. */
const SERVER_TAIL = /^(Это фрагменты|Дальше:|показаны первые|Нигде не встречается|Точное совпадение|По запросу|Индекса нет|Ничего не найдено)/i;

// Строка фрагмента сплошь и рядом начинается с жирного: «**Вердикт совета:** …».
// От заголовка блока её отличают два признака разом: заголовок стоит в начале
// выдачи или после пустой строки, и жирным в нём выделен ПУТЬ ФАЙЛА (.md или
// хотя бы со слэшем). Без этой проверки первый результат терял весь текст.
const looksLikePath = s => /\.md$/i.test(s) || s.includes('/');

export function parseServerSearch(text) {
  const lines = (text || '').split('\n');
  const results = [];
  let cur = null, head = [];
  const flush = () => { if (cur) { cur.frag = cur.frag.join('\n').trim(); results.push(cur); cur = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const atBlockStart = i === 0 || lines[i - 1].trim() === '';
    const m = atBlockStart ? line.match(/^\*\*(.+?)\*\*(.*)$/) : null;
    if (m && looksLikePath(m[1].trim())) {
      flush();
      const rest = m[2] || '';
      const more = rest.match(/\(ещё (\d+)/);
      const chain = (rest.match(/›\s*([^(]+)/) || [, ''])[1].trim();
      cur = { path: m[1].trim(), chain, more: more ? +more[1] : 0, frag: [] };
      continue;
    }
    if (cur) cur.frag.push(line); else head.push(line);
  }
  flush();
  // хвост: служебная подсказка сервера, приклеившаяся к последнему фрагменту
  let tail = head.join('\n').trim();
  const last = results[results.length - 1];
  if (last) {
    const paras = last.frag.split(/\n{2,}/);
    if (paras.length > 1 && SERVER_TAIL.test(paras[paras.length - 1].trim())) {
      tail = paras.pop().trim();
      last.frag = paras.join('\n\n').trim();
    }
  }
  return { results, tail };
}

// Подсветка совпавших слов в готовом фрагменте: терминами являются ОСНОВЫ,
// поэтому подсвечиваем по словам текста, а не регуляркой по запросу —
// иначе «переезда» не подсветится на запрос «переезд».
export function markTerms(escapedText, terms) {
  if (!terms?.length) return escapedText;
  return escapedText.replace(/[0-9a-zA-Zа-яёА-ЯЁ]+/g, w => {
    const ks = keysOf(w);
    for (const term of terms) for (const v of term) for (const k of ks) if (stemsMatch(v, k)) return `<mark>${w}</mark>`;
    return w;
  });
}
