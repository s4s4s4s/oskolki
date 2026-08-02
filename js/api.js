// Слой API: настройки, JSON-RPC к воркеру, живой канал (билет + WebSocket).
// Контракт: POST {url} (…/mcp), Bearer-секрет; неверный секрет/путь → HTTP 404.
import { demoTransport, demoChannel } from './demo.js';

const LS_KEY = 'shards.settings';
export const getSettings = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } };
export const saveSettings = s => localStorage.setItem(LS_KEY, JSON.stringify(s));
export const clearSettings = () => localStorage.removeItem(LS_KEY);

export class AuthError extends Error {}
export class NetError extends Error {}
export class ToolError extends Error {}

let rpcId = 0;

function realTransport(url, secret) {
  async function rpc(method, params) {
    let res;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 20000);
      res = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      clearTimeout(to);
    } catch (e) { throw new NetError('нет сети или воркер недоступен'); }
    if (res.status === 404) throw new AuthError('адрес или секрет неверны');
    if (!res.ok) throw new NetError(`HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new ToolError(j.error.message || 'ошибка RPC');
    return j.result;
  }
  return {
    demo: false,
    ping: () => rpc('ping', {}),
    async call(name, args) {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = r?.content?.[0]?.text ?? '';
      if (r?.isError) return { content: [{ text }], isError: true };
      return { content: [{ text }], isError: false };
    },
  };
}

/* Десктоп: вальт лежит на диске, и ходить за ним в сеть незачем. Тот же набор
   инструментов, но через мост в главный процесс — без секрета, без интернета,
   с мгновенным чтением. Всё остальное приложение об этом не знает: контракт
   транспорта один. */
export const IS_NATIVE = typeof window !== 'undefined' && !!window.shardsNative;

const nativeTransport = {
  demo: false,
  native: true,
  async ping() { const s = await window.shardsNative.state(); if (!s.ready) throw new AuthError('вальт не выбран'); return {}; },
  async call(name, args) {
    const r = await window.shardsNative.call(name, args);
    return { content: [{ text: r.text }], isError: r.isError };
  },
};

export let transport = null;
export function initTransport(settings) {
  transport = settings?.demo ? demoTransport
    : settings?.native ? nativeTransport
    : realTransport(settings.url, settings.secret);
  return transport;
}

// инструменты: возвращают text, при isError бросают ToolError с текстом сервера
async function tool(name, args) {
  const r = await transport.call(name, args);
  if (r.isError) throw new ToolError(r.content[0].text);
  return r.content[0].text;
}
export const tools = {
  list: path => tool('vault_list', { path }),
  read: path => tool('vault_read', { path }),
  section: (path, heading) => tool('vault_section', heading ? { path, heading } : { path }),
  search: (query, limit) => tool('vault_search', limit ? { query, limit } : { query }),
  patch: (path, heading, content, operation, message) => tool('vault_patch', { path, heading, content, operation, ...(message ? { message } : {}) }),
  append: (path, content) => tool('vault_append', { path, content }),
  create: (path, content) => tool('vault_create', { path, content }),
};
export const isConflict = e => e instanceof ToolError && /конфликт/i.test(e.message);

// ── живой канал ──────────────────────────────────────────────
// POST {url без /mcp}/ticket → {ts,t}; wss://{хост}/ws?ts&t; билет живёт 2 мин.
export function liveChannel(settings) {
  if (settings?.demo) return demoChannel();
  // На десктопе живой канал — это слежение за файлами вальта: git pull, правка
  // в Obsidian или запись из чата видны сразу, без вебхука и WebSocket.
  if (settings?.native) {
    const ch = { onEvent: null, onStatus: null };
    ch.start = () => {
      window.shardsNative.onChanged(ev => ch.onEvent && ch.onEvent({
        type: 'push', sha: 'local', message: `изменено файлов: ${ev.paths.length}`,
        paths: ev.paths, indexTouched: ev.indexTouched,
      }));
      ch.onStatus && ch.onStatus('live');
    };
    ch.stop = () => {};
    ch.kick = () => {};
    return ch;
  }
  const base = settings.url.replace(/\/mcp\/?$/, '');
  const { host, protocol } = new URL(base);
  // ws:// для локального стенда, wss:// для боевого воркера — иначе на localhost
  // браузер рвёт соединение до рукопожатия и живой канал вообще не проверить
  const wsScheme = protocol === 'http:' ? 'ws' : 'wss';
  const ch = { onEvent: null, onStatus: null, _ws: null, _try: 0, _stop: false, _timers: [] };
  const status = s => ch.onStatus && ch.onStatus(s);

  async function connect() {
    if (ch._stop) return;
    status(ch._try ? 'retry' : 'connecting');
    let ticket;
    try {
      const res = await fetch(`${base}/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${settings.secret}` } });
      if (!res.ok) throw 0;
      ticket = await res.json();
    } catch { return retry(); }
    const ws = new WebSocket(`${wsScheme}://${host}/ws?ts=${ticket.ts}&t=${encodeURIComponent(ticket.t)}`);
    ch._ws = ws;
    let pingTimer;
    ws.onopen = () => { ch._try = 0; status('live'); pingTimer = setInterval(() => { try { ws.send('ping'); } catch {} }, 25000); ch._timers.push(pingTimer); };
    ws.onmessage = ev => {
      if (ev.data === 'pong') return;
      try { const j = JSON.parse(ev.data); if (j.type === 'push' && ch.onEvent) ch.onEvent(j); } catch {}
    };
    ws.onclose = () => { clearInterval(pingTimer); if (!ch._stop) retry(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function retry() {
    if (ch._stop) return;
    status('retry');
    const delay = Math.min(30000, 1000 * 2 ** Math.min(ch._try++, 5)) + Math.random() * 800;
    ch._timers.push(setTimeout(connect, delay));
  }
  ch.start = () => { ch._stop = false; connect(); };
  ch.stop = () => { ch._stop = true; ch._timers.forEach(clearTimeout); try { ch._ws?.close(); } catch {} status('dead'); };
  ch.kick = () => { if (!ch._ws || ch._ws.readyState > 1) { ch._try = 0; connect(); } };
  return ch;
}
