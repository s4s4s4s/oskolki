/**
 * Dev-стенд «Осколков»: мок vault-mcp поверх НАСТОЯЩЕГО вальта + статика приложения.
 *
 * Зачем: боевой воркер требует секрет, а демо-вальт (js/demo.js) — восемь игрушечных
 * заметок. Ни то, ни другое не показывает, как приложение ведёт себя на реальных
 * двух сотнях заметок с реальными зонами, длиной текста и связями. Стенд повторяет
 * контракт воркера буква в букву: JSON-RPC на /mcp, Bearer, 404 на неверный секрет,
 * билет на /ticket, WebSocket на /ws, те же тексты ответов инструментов.
 *
 * Поиск берётся из js/search.js — того самого модуля, что работает в приложении.
 * Если порт разойдётся с worker.js, это будет видно здесь, а не в бою.
 *
 * ЗАПИСЬ НЕ ТРОГАЕТ ВАЛЬТ. Всё, что приложение пишет, ложится в оверлей
 * `_dev/sandbox/` и оттуда же читается с приоритетом. Так vault_patch/append/create
 * проверяются по-настоящему, а second-brain остаётся нетронутым.
 *
 * Запуск:  node _dev/server.mjs [--vault ПУТЬ] [--port 8787] [--secret dev]
 * Открыть: http://localhost:8787/  → URL воркера http://localhost:8787/mcp, секрет dev
 */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareChunks, parseSynonyms, rankFiles, excerpt } from '../js/search.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const VAULT = resolve(arg('vault', 'C:/Users/sasha/Documents/Obsidian Vault'));
const PORT = +arg('port', 8787);
const SECRET = arg('secret', 'dev');
const SANDBOX = join(HERE, 'sandbox');
const INDEX_DIR = '_машина/индекс';
const SYNONYMS = '_машина/синонимы.md';

/* ── файлы: оверлей поверх вальта ─────────────────────────────────────────── */

const safe = p => {
  const clean = String(p || '').replace(/^\/+|\/+$/g, '');
  if (clean.includes('..')) throw new Error('плохой путь');
  return clean;
};
const overlayPath = p => join(SANDBOX, ...safe(p).split('/'));
const vaultPath = p => join(VAULT, ...safe(p).split('/'));

async function readNote(p) {
  const o = overlayPath(p);
  if (existsSync(o)) return { text: await readFile(o, 'utf8'), sha: 'overlay', where: 'sandbox' };
  const v = vaultPath(p);
  if (!existsSync(v)) return null;
  const st = await stat(v);
  if (st.isDirectory()) throw new Error(`${p} — это папка, не файл`);
  return { text: await readFile(v, 'utf8'), sha: 'vault', where: 'vault' };
}

async function writeNote(p, text) {
  const o = overlayPath(p);
  await mkdir(dirname(o), { recursive: true });
  await writeFile(o, text, 'utf8');
  return createHash('sha1').update(text).digest('hex').slice(0, 7);
}

async function listDir(p) {
  const clean = safe(p);
  const seen = new Map();
  for (const root of [vaultPath(clean), overlayPath(clean)]) {
    if (!existsSync(root)) continue;
    for (const e of await readdir(root, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = join(root, e.name);
      const rel = clean ? `${clean}/${e.name}` : e.name;
      const size = e.isFile() ? (await stat(full)).size : 0;
      seen.set(rel, { type: e.isDirectory() ? 'dir' : 'file', path: rel, size });
    }
  }
  if (!seen.size) throw new Error('GitHub 404');
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path, 'ru'));
}

/* ── разделы файла: та же логика, что в worker.js ─────────────────────────── */

const cleanH = s => s.replace(/\u00a0/g, ' ').trim().toLowerCase();

function findHeading(lines, heading) {
  const want = cleanH(heading);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && cleanH(m[2]) === want) return { index: i, level: m[1].length };
  }
  return null;
}
function sectionEnd(lines, from, level) {
  for (let i = from + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) return i;
  }
  return lines.length;
}
function headingList(lines, limit = 100) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/^(#{1,6})\s+(.*)$/);
    if (m) out.push(`${'  '.repeat(m[1].length - 1)}${m[1]} ${m[2]}`);
    if (out.length >= limit) break;
  }
  return out;
}
// Тексты ошибок повторяют worker.js буква в букву: приложение разбирает их
// регулярками, и стенд, «улучшивший» формулировку, скрыл бы поломку до боя.
const isListItem = s => /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(s || '');

function applyPatch(text, { heading, content, operation }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const found = findHeading(lines, heading);
  if (!found) {
    const have = headingList(lines, 25).map(h => h.trim()).join(' | ');
    throw new Error(`Заголовок «${heading}» не найден. Есть: ${have || 'заголовков нет'}`);
  }
  const end = sectionEnd(lines, found.index, found.level);
  const block = content.replace(/\s+$/, '').split('\n');
  if (operation === 'replace') {
    lines.splice(found.index + 1, end - found.index - 1, '', ...block, '');
    return lines.join('\n');
  }
  if (operation === 'prepend') {
    let at = found.index + 1;
    while (at < lines.length && lines[at].trim() === '') at++;
    const glue = isListItem(block[block.length - 1]) && isListItem(lines[at]) ? [] : [''];
    lines.splice(at, 0, ...block, ...glue);
    return lines.join('\n');
  }
  let at = end;
  while (at > found.index + 1 && lines[at - 1].trim() === '') at--;
  const glue = isListItem(lines[at - 1]) && isListItem(block[0]) ? [] : [''];
  lines.splice(at, 0, ...glue, ...block);
  return lines.join('\n');
}

/* ── индекс для поиска ────────────────────────────────────────────────────── */

// эмуляция гонки устройств для проверки ветки конфликта в приложении
const conflict = { on: false, sticky: false };

let index = null;
async function loadIndex() {
  if (index) return index;
  const raw = [];
  for (const e of await listDir(INDEX_DIR)) {
    if (e.type !== 'file' || !e.path.endsWith('.json') || e.path.endsWith('meta.json')) continue;
    raw.push(...JSON.parse((await readNote(e.path)).text));
  }
  const syn = await readNote(SYNONYMS).catch(() => null);
  index = { chunks: prepareChunks(raw), synonyms: parseSynonyms(syn?.text || '') };
  console.log(`[стенд] индекс: ${index.chunks.length} кусков, синонимов ${index.synonyms.length} групп`);
  return index;
}

/* ── инструменты ──────────────────────────────────────────────────────────── */

async function callTool(name, args = {}) {
  switch (name) {
    case 'vault_search': {
      const limit = Math.min(Math.max(args.limit || 6, 1), 20);
      const { chunks, synonyms } = await loadIndex();
      const { files, terms } = rankFiles(chunks, args.query, synonyms, limit);
      if (!files.length) {
        return `По запросу «${args.query}» в заметках совпадений нет (искал по ${chunks.length} фрагментам).\nНигде не встречается. Скажи, что этого в памяти нет — не достраивай ответ по догадке.`;
      }
      const out = files.map(({ p, best, n }) => {
        const chain = best.c.h.length ? ` › ${best.c.h.join(' › ')}` : '';
        const more = n > 1 ? `  (ещё ${n - 1} ${n - 1 === 1 ? 'фрагмент' : 'фрагмента'} в этом файле)` : '';
        return `**${p}**${chain}${more}\n${excerpt(best.c.t, terms)}`;
      });
      return [out.join('\n\n'), '', 'Это фрагменты, а не ответ. Если прямого ответа в них нет — прочитай нужный файл (vault_section по заголовку выше или vault_read целиком), а если и там нет — так и скажи, что в памяти этого нет.'].join('\n');
    }
    case 'vault_read': {
      const f = await readNote(args.path);
      if (!f) throw new Error(`Файла ${args.path} нет`);
      return f.text;
    }
    case 'vault_section': {
      const f = await readNote(args.path);
      if (!f) throw new Error(`Файла ${args.path} нет`);
      const lines = f.text.split('\n');
      if (!args.heading) {
        return `${args.path} — ${f.text.length} символов. Заголовки:\n${headingList(lines).join('\n') || '(заголовков нет)'}\n\nvault_section(path, heading) вернёт один раздел.`;
      }
      const found = findHeading(lines, args.heading);
      if (!found) throw new Error(`Заголовка «${args.heading}» нет. Есть:\n${headingList(lines, 30).join('\n')}`);
      const end = sectionEnd(lines, found.index, found.level);
      const body = lines.slice(found.index, end).join('\n').replace(/\s+$/, '');
      return `${body}\n\n— раздел «${args.heading}» из ${args.path} (${body.length} из ${f.text.length} символов файла)`;
    }
    case 'vault_patch': {
      const f = await readNote(args.path);
      if (!f) throw new Error(`Файла ${args.path} нет. Создай через vault_create.`);
      const op = ['append', 'replace'].includes(args.operation) ? args.operation : 'prepend';
      // Ветку конфликта иначе не проверить: включается POST /dev/conflict {"on":true}
      if (conflict.on) { conflict.on = conflict.sticky; throw new Error('Конфликт: файл изменился с момента чтения. Повтори вызов — он перечитает свежую версию.'); }
      const updated = applyPatch(f.text, { heading: args.heading, content: args.content, operation: op });
      const c = await writeNote(args.path, updated);
      push([args.path], args.message || `patch: ${args.path}`);
      return `Записано в ${args.path} под «${args.heading}» (${op}). Коммит ${c}. Было ${f.text.length} символов, стало ${updated.length}.`;
    }
    case 'vault_append': {
      const f = await readNote(args.path);
      const updated = (f ? f.text.replace(/\s+$/, '') + '\n\n' : '') + args.content.replace(/\s+$/, '') + '\n';
      const c = await writeNote(args.path, updated);
      push([args.path], args.message || `append: ${args.path}`);
      return `${f ? 'Дописано в' : 'Создан'} ${args.path}. Коммит ${c}.`;
    }
    case 'vault_create': {
      if (await readNote(args.path)) throw new Error(`${args.path} уже существует. Используй vault_patch или vault_append.`);
      const c = await writeNote(args.path, args.content);
      push([args.path], args.message || `create: ${args.path}`);
      return `Создан ${args.path}. Коммит ${c}.`;
    }
    case 'vault_list': {
      const entries = await listDir(args.path || '');
      return entries.map(e => `${e.type === 'dir' ? '[папка] ' : ''}${e.path}${e.type === 'file' ? ` (${e.size} б)` : ''}`).join('\n');
    }
    default:
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

/* ── живой канал: WebSocket без библиотек ─────────────────────────────────── */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Set();
const tickets = new Map();

function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

// Разбор входящих кадров: нужен только текст (ping) и close.
function wsRead(buf, onText, onClose) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const op = buf[off] & 0x0f, masked = buf[off + 1] & 0x80;
    let len = buf[off + 1] & 0x7f, pos = off + 2;
    if (len === 126) { len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    let mask = null;
    if (masked) { mask = buf.slice(pos, pos + 4); pos += 4; }
    if (pos + len > buf.length) return buf.slice(off);
    const data = buf.slice(pos, pos + len);
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    if (op === 0x8) { onClose(); return Buffer.alloc(0); }
    if (op === 0x1) onText(data.toString('utf8'));
    off = pos + len;
  }
  return buf.slice(off);
}

function push(paths, message) {
  const ev = JSON.stringify({
    type: 'push',
    sha: randomUUID().replace(/-/g, '').slice(0, 40),
    message,
    paths,
    indexTouched: paths.some(p => p.startsWith(INDEX_DIR)),
  });
  for (const s of sockets) { try { s.write(wsFrame(ev)); } catch {} }
  console.log(`[стенд] push → ${sockets.size} окн(о): ${message}`);
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

const authed = req => (req.headers.authorization || '') === `Bearer ${SECRET}`;
const notFound = res => { res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === '/mcp') {
    if (!authed(req) || req.method !== 'POST') return notFound(res);
    let msg;
    try { msg = JSON.parse(await body(req)); } catch { return notFound(res); }
    const reply = obj => { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...obj })); };
    try {
      if (msg.method === 'ping') return reply({ result: {} });
      if (msg.method === 'initialize') return reply({ result: { protocolVersion: '2025-06-18', serverInfo: { name: 'vault-mcp-dev', version: 'dev' }, capabilities: { tools: {} } } });
      if (msg.method === 'tools/call') {
        try {
          const text = await callTool(msg.params?.name, msg.params?.arguments || {});
          return reply({ result: { content: [{ type: 'text', text }] } });
        } catch (e) {
          return reply({ result: { content: [{ type: 'text', text: e.message }], isError: true } });
        }
      }
      return reply({ error: { code: -32601, message: `неизвестный метод ${msg.method}` } });
    } catch (e) {
      return reply({ error: { code: -32000, message: e.message } });
    }
  }

  if (url.pathname === '/ticket') {
    if (!authed(req) || req.method !== 'POST') return notFound(res);
    const ts = Date.now(), t = randomUUID();
    tickets.set(t, ts);
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ts, t }));
  }

  // включить/выключить эмуляцию конфликта записи: -d '{"on":true,"sticky":false}'
  if (url.pathname === '/dev/conflict' && req.method === 'POST') {
    const j = JSON.parse((await body(req)) || '{}');
    conflict.on = !!j.on; conflict.sticky = !!j.sticky;
    console.log(`[стенд] конфликт: ${conflict.on ? 'включён' : 'выключен'}${conflict.sticky ? ' (постоянный)' : ''}`);
    res.writeHead(200, CORS); return res.end('ok');
  }

  // ручной пуш для проверки живого канала: curl -X POST .../dev/push -d '{"paths":["brain/hot.md"]}'
  if (url.pathname === '/dev/push' && req.method === 'POST') {
    const j = JSON.parse((await body(req)) || '{}');
    push(j.paths || ['brain/hot.md'], j.message || 'ручной пуш со стенда');
    res.writeHead(200, CORS); return res.end('ok');
  }

  // статика приложения
  if (req.method !== 'GET') return notFound(res);
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = resolve(APP, '.' + p);
  if (!file.startsWith(APP + sep) || !existsSync(file)) return notFound(res);
  const st = await stat(file);
  if (st.isDirectory()) return notFound(res);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(await readFile(file));
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/ws' || !tickets.has(url.searchParams.get('t'))) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  console.log(`[стенд] ws подключён (${sockets.size})`);
  let buf = Buffer.alloc(0);
  socket.on('data', d => {
    buf = wsRead(Buffer.concat([buf, d]),
      text => { if (text === 'ping') socket.write(wsFrame('pong')); },
      () => socket.end());
  });
  const bye = () => { sockets.delete(socket); console.log(`[стенд] ws отключён (${sockets.size})`); };
  socket.on('close', bye); socket.on('error', bye);
});

await mkdir(SANDBOX, { recursive: true });
server.listen(PORT, () => {
  console.log(`[стенд] вальт:    ${VAULT}`);
  console.log(`[стенд] оверлей:  ${SANDBOX} (запись идёт сюда, вальт не трогается)`);
  console.log(`[стенд] открыть:  http://localhost:${PORT}/`);
  console.log(`[стенд] воркер:   http://localhost:${PORT}/mcp   секрет: ${SECRET}`);
});
