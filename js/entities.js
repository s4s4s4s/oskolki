// Сущностный слой: доступ к памяти через якоря, а не через слова.
//
// Замер показал, почему словесный поиск выигрывает у векторного: вопросы к
// личной памяти почти всегда про сущность — «кто такая Ксюша», «что с налогами»,
// «как перевести акции». BM25 точен на именах, векторы имя размывают.
//
// Отсюда следующий шаг: если вопрос про сущность, то и отвечать надо не
// фрагментами текста, а тем, что про неё известно — утверждениями, свежими
// сверху, с отменёнными отдельно. Это не «ещё один поиск», а другой способ
// доступа: от якоря к знанию, а не от слова к файлу.
import { corpus } from './corpus.js';
import { stem } from './search.js';

const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').trim();

let cache = null;
const stamp = () => corpus.loadedAt?.getTime() || 0;

/* Указатель имён. Одна сущность отзывается на несколько имён: заголовок,
   псевдонимы из фронтматтера, имя файла. «Ксюша» и «Ксения» должны вести в одно
   место — иначе половина вопросов не найдёт того, что заведомо есть.

   Хранится и полное имя, и его первое слово: спрашивают «что там с Аделиной»,
   а сущность называется «Аделина Габдулвалиева». */
export function entityIndex() {
  if (cache && cache.at === stamp()) return cache;
  const byName = new Map();
  const add = (name, note, weight) => {
    const k = norm(name);
    if (k.length < 3) return;
    const cur = byName.get(k);
    if (!cur || cur.weight < weight) byName.set(k, { note, weight });
  };
  const list = corpus.notes.filter(n => n.klass === 'сущность');
  for (const n of list) {
    add(n.title, n, 3);
    add(n.base, n, 3);
    for (const a of n.aliases || []) add(a, n, 3);
    /* Отдельные слова имени — слабыми псевдонимами. Спрашивают «что с
       релокацией», а сущность называется «Образование и релокация»; требовать
       полного совпадения значит не находить почти ничего.

       Порог в шесть букв отсекает служебные слова («для», «план», «проект»),
       из-за которых сущности начали бы перетягивать к себе чужие вопросы. Вес
       низкий: точное совпадение полного имени всегда побеждает. */
    for (const w of n.title.split(/[^0-9A-Za-zА-Яа-яЁё+-]+/)) {
      if (w.length >= 6 && norm(w) !== norm(n.title)) add(w, n, 1);
    }
  }
  cache = { byName, list, at: stamp() };
  return cache;
}

/* Поиск сущностей в вопросе. Идём по длине имени вниз: «Проект bio+IT» должен
   победить «bio», иначе длинные имена не находятся никогда. Совпадение по
   основе, чтобы «Ксюши» и «Ксюше» вели туда же, куда «Ксюша». */
export function findEntities(query, limit = 3) {
  const { byName } = entityIndex();
  const q = norm(query);
  const qStems = new Set(q.split(/[^0-9a-zа-я]+/).filter(w => w.length > 2).map(stem));
  const hits = [];
  for (const [name, { note, weight }] of byName) {
    if (q.includes(name)) { hits.push({ note, score: name.length * 2 + weight }); continue; }
    const parts = name.split(/[^0-9a-zа-я]+/).filter(w => w.length > 2);
    if (!parts.length) continue;
    const matched = parts.filter(p => qStems.has(stem(p))).length;
    if (matched === parts.length) hits.push({ note, score: name.length + weight });
  }
  const best = new Map();
  for (const h of hits) {
    const cur = best.get(h.note);
    if (!cur || cur.score < h.score) best.set(h.note, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(h => h.note);
}

// Утверждения о сущности: свежие сверху, отменённые в конце — но не спрятаны.
export function claimsOf(entity) {
  const claims = (entity.backlinks || []).filter(l => l.type === 'about').map(l => l.from);
  const dead = c => c.status === 'отменено' || c.status === 'устарело';
  return claims.sort((a, b) =>
    (dead(a) - dead(b)) || String(b.when || '').localeCompare(String(a.when || '')));
}

/* Ответ на вопрос про сущность: сама сущность, что про неё известно и с кем она
   рядом. Соседи — по общим утверждениям: если два человека упоминаются в одних
   и тех же фактах, они связаны, даже когда ссылки между ними нет. */
export function entityAnswer(query, { claims = 12 } = {}) {
  const found = findEntities(query);
  if (!found.length) return null;
  return found.map(entity => {
    const list = claimsOf(entity);
    const near = new Map();
    for (const c of list) {
      for (const l of c.links || []) {
        if (l.type !== 'about' || l.to === entity) continue;
        near.set(l.to, (near.get(l.to) || 0) + 1);
      }
    }
    return {
      entity,
      claims: list.slice(0, claims),
      total: list.length,
      near: [...near].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => ({ note: n, count: c })),
    };
  });
}

// Сводка по всему скелету: сколько сущностей каждого вида и сколько из них
// вообще ничем не подкреплены — пустой якорь и есть работа для извлечения.
export function entityStats() {
  const { list } = entityIndex();
  const byKind = new Map();
  for (const n of list) {
    const k = n.kind || 'прочее';
    if (!byKind.has(k)) byKind.set(k, { total: 0, withClaims: 0, claims: 0 });
    const g = byKind.get(k);
    g.total++;
    const c = (n.backlinks || []).filter(l => l.type === 'about').length;
    if (c) { g.withClaims++; g.claims += c; }
  }
  return [...byKind].sort((a, b) => b[1].total - a[1].total);
}
