/**
 * Заглушка эндпоинта эмбеддингов — ТОЛЬКО чтобы проверить тракт.
 *
 * Она честно считает вектор, но считает его хешированием слов: смысла в нём
 * ноль, синонимов она не знает и знать не может. Годится ровно для одного —
 * убедиться, что сборщик пишет шарды, приложение их читает, косинус считается,
 * а RRF складывает списки. Качество поиска на ней мерить нельзя: получится
 * замер лексического совпадения, то есть тот же BM25, только хуже.
 *
 * Настоящие векторы даёт предобученная модель, которая знает, что «горит» —
 * это про срочное, а «Sperrkonto» — про деньги для визы. Локально это ollama:
 *     ollama pull nomic-embed-text
 * После этого сборщик и мерилка работают без единого изменения — заглушка
 * отличается от неё только адресом.
 *
 * Запуск: node _dev/fake-embed.mjs [порт]
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 11435);
const DIM = 256;

// Хеш слова в координату со знаком: детерминированно и без состояния.
const h32 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

function vector(text) {
  const v = new Float64Array(DIM);
  const words = String(text).toLowerCase().split(/[^0-9a-zа-яё]+/).filter(w => w.length > 2);
  for (const w of words) {
    // Пара «основа + биграммы» — чтобы близкие формы слова давали близкие
    // векторы: это единственное, что заглушка вообще умеет.
    const keys = [w.slice(0, 6)];
    for (let i = 0; i < w.length - 2; i++) keys.push(w.slice(i, i + 3));
    for (const k of keys) {
      const x = h32(k);
      v[x % DIM] += (x & 1 ? 1 : -1) / Math.sqrt(keys.length);
    }
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return [...v].map(x => x / n);
}

// Запрос с `content-type: application/json` браузер шлёт не сразу: сперва идёт
// OPTIONS-предпроверка, и без ответа на неё fetch падает с невнятным «Failed to
// fetch». Настоящая ollama ведёт себя так же, пока ей не разрешить источник
// переменной OLLAMA_ORIGINS, — поэтому заглушка обязана вести себя честно.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '86400',
};

createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch {}
    const text = j.prompt ?? j.input ?? '';
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ embedding: vector(text), model: j.model || 'fake' }));
  });
}).listen(PORT, () => console.log(`[заглушка] эмбеддинги на http://localhost:${PORT}/api/embeddings — только для проверки тракта`));
