// Карта вальта: лёгкая модель всего корпуса + поиск по инвертированному словарю.
//
// Старая схема тянула в браузер весь текст заметок. На двух сотнях это 1,6 МБ и
// незаметно; на десяти тысячах — под 80 МБ, двенадцать секунд на подготовку основ
// и секунды на каждый запрос. Здесь по-другому:
//
//   карта.json    — по строке на заметку (~345 байт): путь, заголовок, тип,
//                   статус, теги, даты, размер, связи с типами, оглавление.
//                   Грузится сразу и целиком: это и есть карта.
//   словарь/NNN   — «основа слова → заметки», шардирован по хешу термина.
//                   Запрос из четырёх слов читает четыре шарда, а не корпус.
//   ключи.json    — по десять весомых слов на заметку, для «похожих» и кластеров.
//                   Грузится при первом обращении, не раньше.
//
// Текста здесь нет: фрагмент дешевле прочитать из самой заметки, когда он
// понадобился, чем держать копию всего вальта второй раз.
import { tools } from './api.js';
import { MAP_DIR } from './config.js';
import { queryTerms, parseSynonyms, authority, excerpt, stemsMatch } from './search.js';

export const mapState = {
  loaded: false,
  raw: null,          // как пришло из карта.json
  shards: 16,
  synonyms: [],
  keywords: null,     // [[термин…], …] по индексу заметки
};

const dictCache = new Map();   // номер шарда → {термин: "doc:tfBtfM,…"}
const textCache = new Map();   // путь → текст заметки (для фрагментов и чтения)
const TEXT_CACHE_MAX = 200;

// Хеш обязан совпадать со сборщиком: разойдётся — половина слов будет искаться
// не в том шарде и просто не найдётся.
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0; return h; };

/* ── загрузка ─────────────────────────────────────────────────────────────── */

export async function fetchMap(onStep) {
  onStep && onStep('читаю карту вальта…');
  const raw = JSON.parse((await tools.read(`${MAP_DIR}/карта.json`)).replace(/^﻿/, ''));
  const synonyms = await tools.read('_машина/синонимы.md').catch(() => '');
  return { map: raw, synonyms, at: new Date().toISOString() };
}

export function applyMap({ map, synonyms }) {
  mapState.raw = map;
  mapState.shards = map.shards || 16;
  mapState.synonyms = parseSynonyms(synonyms || '');
  mapState.loaded = true;
  dictCache.clear();
  return map;
}

/* Шард словаря плюс два индекса поверх него.

   Морфология сводит «карточка» и «карточек» не всегда — стеммер оставляет
   разные основы, и добор идёт сравнением по первым буквам. Наивно это значит
   «пройти все ключи шарда на каждое слово запроса», и запрос вырастал до
   секунды. Префиксная корзина превращает перебор в выборку, а разобранные
   постинги кэшируются: один и тот же ключ читается запросами многократно. */
const PREFIX = 4;

async function shard(n) {
  if (dictCache.has(n)) return dictCache.get(n);
  const name = `${MAP_DIR}/словарь/${String(n).padStart(3, '0')}.json`;
  const data = await tools.read(name).then(t => JSON.parse(t.replace(/^﻿/, ''))).catch(() => ({}));
  const byPrefix = new Map();
  for (const key in data) {
    const p = key.slice(0, PREFIX);
    let bucket = byPrefix.get(p);
    if (!bucket) byPrefix.set(p, (bucket = []));
    bucket.push(key);
  }
  const entry = { dict: data, byPrefix, parsed: new Map() };
  // Кэш неограничен намеренно: шардов десятки, каждый в сотни килобайт, и
  // повторный запрос по тем же словам должен быть мгновенным.
  dictCache.set(n, entry);
  return entry;
}

export async function keywords() {
  if (mapState.keywords) return mapState.keywords;
  mapState.keywords = await tools.read(`${MAP_DIR}/ключи.json`)
    .then(t => JSON.parse(t.replace(/^﻿/, ''))).catch(() => []);
  return mapState.keywords;
}

/* ── чтение текста заметки ────────────────────────────────────────────────── */

// Текста в индексе нет, поэтому читаем сами — но помним прочитанное: на экране
// заметки, в поиске и в контексте для ИИ один и тот же файл нужен по три раза.
export async function noteText(path, { fresh = false } = {}) {
  if (!fresh && textCache.has(path)) return textCache.get(path);
  const text = await tools.read(path);
  if (textCache.size >= TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
  textCache.set(path, text);
  return text;
}
export const forgetText = path => textCache.delete(path);

/* ── поиск ────────────────────────────────────────────────────────────────── */

const parsePostings = s => s.split(',').map(pair => {
  const i = pair.lastIndexOf(':');
  const doc = +pair.slice(0, i);
  const flags = pair.slice(i + 1);
  return [doc, +flags[0] || 0, +flags[1] || 0];
});

/* Оценка та же по смыслу, что у воркера: попадание в заголовок или путь весит
   больше, чем в тело, а покрытие запроса важнее веса — заметка, зацепившая все
   слова вопроса, полезнее длинной, зацепившей половину сильно. Отличие в том,
   что считается не по кускам текста, а по заметке целиком: кусков здесь нет. */
/* Ранжирование — BM25 с бонусом за попадание в заголовок и путь.

   Голая частота слова не годится: журнал сессий на 36 КБ упоминает всё подряд
   и по любому запросу оказывался бы первым просто потому, что он длинный.
   BM25 гасит и длину документа, и частоту (десятое упоминание значит куда
   меньше второго), а редкие слова весит выше частых. Сверху — тот же авторитет
   источника, что в воркере: журналы и очередь весят 0.4, потому что упоминают,
   а не утверждают. */
/* Веса подобраны на десяти вопросах с заранее известным ответом: все варианты
   давали 10/10 попаданий в топ-5, разброс был только в том, сколько ответов
   оказалось первыми (6–9). Разница в один-два вопроса на такой выборке — шум,
   поэтому взяты устойчивые средние, а не победитель замера. Дальше крутить их
   по этому же набору нельзя: так меряют стенд, а не поиск. */
export const rank = { k1: 1.4, b: 0.3, wMeta: 2.2 };
// В постинге частота лежит одной цифрой по логарифмической шкале — разворачиваем.
const tfOf = d => d ? 2 ** (d - 1) : 0;

export async function searchMap(query, limit = 25) {
  if (!mapState.loaded) return { results: [], terms: [] };
  const terms = queryTerms(query, mapState.synonyms);
  if (!terms.length) return { results: [], terms };

  // Один шард на термин — вот всё, что читается на запрос независимо от того,
  // двести в вальте заметок или двести тысяч.
  const needed = new Set();
  for (const term of terms) for (const v of term) needed.add(hash(v) % mapState.shards);
  const loaded = new Map();
  await Promise.all([...needed].map(async n => loaded.set(n, await shard(n))));

  const notes = mapState.raw.notes;
  const N = notes.length;
  const avgLen = mapState.avgLen || (mapState.avgLen =
    notes.reduce((a, n) => a + (n.b || 1), 0) / Math.max(1, N));

  const score = new Map();   // doc → {s, hits}
  terms.forEach(term => {
    const best = new Map();  // doc → лучший вес по этому слову запроса
    const consider = (postings, df, mult) => {
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [doc, tb, tm] of postings) {
        const len = notes[doc]?.b || avgLen;
        const tf = tfOf(tb);
        const norm = tf ? (tf * (rank.k1 + 1)) / (tf + rank.k1 * (1 - rank.b + rank.b * len / avgLen)) : 0;
        const w = idf * (norm + tm * rank.wMeta) * mult;
        if (w > (best.get(doc) || 0)) best.set(doc, w);
      }
    };
    for (const variant of term) {
      const sh = loaded.get(hash(variant) % mapState.shards);
      if (!sh) continue;
      const postingsOf = key => {
        let p = sh.parsed.get(key);
        if (!p) sh.parsed.set(key, (p = parsePostings(sh.dict[key])));
        return p;
      };
      // Точное совпадение основы — обычный случай. Если его нет, добираем
      // соседей по префиксу: только они и могут совпасть по первым буквам.
      if (sh.dict[variant] !== undefined) {
        const p = postingsOf(variant);
        consider(p, p.length, 1);
      } else {
        for (const key of sh.byPrefix.get(variant.slice(0, PREFIX)) || []) {
          const m = stemsMatch(variant, key);
          if (!m) continue;
          const p = postingsOf(key);
          consider(p, p.length, m);
        }
      }
    }
    for (const [doc, w] of best) {
      const cur = score.get(doc) || { s: 0, hits: 0 };
      cur.s += w; cur.hits++;
      score.set(doc, cur);
    }
  });
  const results = [...score]
    .map(([doc, { s, hits }]) => {
      const coverage = hits / terms.length;
      const n = notes[doc];
      return { doc, path: n.p, title: n.t, coverage, rank: s * coverage * coverage * authority(n.p) };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);

  return { results, terms };
}

// Фрагмент показываем только для того, что человек реально увидит: читать все
// двадцать заметок ради сниппетов — это те же лишние секунды, от которых
// уходили. Топ-5 хватает, остальное подтягивается при прокрутке.
export async function withSnippets(results, terms, count = 5) {
  await Promise.all(results.slice(0, count).map(async r => {
    try {
      const text = await noteText(r.path);
      const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
      r.frag = excerpt(body, terms);
    } catch { r.frag = ''; }
  }));
  return results;
}
