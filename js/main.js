// Точка входа: загрузка, роутер, верхняя/нижняя полосы, живой канал, клавиатура.
import { getSettings, saveSettings, clearSettings, initTransport, liveChannel, transport, IS_NATIVE } from './api.js';
import { fetchIndex, buildModel, applyModel, corpus } from './corpus.js';
import { renderConnect, renderGraph, renderNote, renderCards, renderSearch, renderAsk, initCapture, initNoteCreator, toast, notePush, $ } from './views.js';
import { IS_APP, INDEX_REBUILD_MS } from './config.js';
import { loadIndexCache, saveIndexCache } from './store.js';
import { flushQueue, pendingWrites } from './write.js';
import { fmtAge } from './md.js';

const view = $('#view');
const state = { channel: null, capture: null, graph: null, offline: null, reloadTimer: null };

/* ── верхняя полоса ── */
function drawStrip(active) {
  $('#tabs').querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.r === active));
  $('#top-count').textContent = corpus.notes.length ? `УЗЛОВ ${corpus.notes.length} · РЁБЕР ${corpus.edges.length}` : '';
  $('#top-mode').textContent = transport?.demo ? 'ДЕМО' : '';
}
function setWs(status, label) {
  const ws = $('#ws');
  ws.className = `ws ${status}`;
  $('#ws-label').textContent = label;
}

/* ── роутер ── */
function route() {
  if (!currentSettings()) return; // экран подключения владеет вью
  if (!corpus.notes.length) return; // ещё грузимся
  const h = location.hash || '#/graph';
  const [, name, rest] = h.match(/^#\/([^/?]*)\/?(.*)$/) || [];
  if (state.graph) { state.graph.stop(); state.graph = null; }
  if (name === 'note' && rest) {
    drawStrip('');
    renderNote(view, decodeURIComponent(rest));
    setBar('E ПРАВИТЬ РАЗДЕЛ&nbsp;&nbsp;&nbsp;КЛИК ПО [[ССЫЛКЕ]] — ПЕРЕХОД&nbsp;&nbsp;&nbsp;ESC — К ГРАФУ');
  } else if (name === 'cards') {
    drawStrip('cards'); renderCards(view);
    setBar('ENTER ОТКРЫТЬ&nbsp;&nbsp;&nbsp;ФИЛЬТРЫ И СОРТИРОВКИ — СВЕРХУ');
  } else if (name === 'search') {
    drawStrip('search');
    const q = new URLSearchParams(rest.split('?')[1] || h.split('?')[1] || '').get('q') || '';
    renderSearch(view, q);
    setBar('ENTER — ИСКАТЬ / ОТКРЫТЬ ПЕРВОЕ&nbsp;&nbsp;&nbsp;ПАМЯТЬ — МГНОВЕННО И ОФЛАЙН, СЕРВЕР — СВЕЖЕЕ');
  } else if (name === 'ask') {
    drawStrip('ask');
    const q = new URLSearchParams(rest.split('?')[1] || h.split('?')[1] || '').get('q') || '';
    renderAsk(view, q);
    setBar('ENTER — СПРОСИТЬ&nbsp;&nbsp;&nbsp;ОТВЕТ СТРОИТСЯ ТОЛЬКО НА ФРАГМЕНТАХ СНИЗУ&nbsp;&nbsp;&nbsp;БЕЗ КЛЮЧА — ПАКЕТ В БУФЕР');
  } else {
    drawStrip('graph');
    renderGraph(view, state);
    setBar('ПЕРЕТАСКИВАНИЕ — ПАН&nbsp;&nbsp;&nbsp;КОЛЕСО — ЗУМ&nbsp;&nbsp;&nbsp;TAB/СТРЕЛКИ — ПО УЗЛАМ&nbsp;&nbsp;&nbsp;ENTER — ОТКРЫТЬ');
  }
}
const setBar = html => { $('#bar-hints').innerHTML = html; };

/* ── загрузка корпуса ──────────────────────────────────────────────────────
   Сначала офлайн-копия, потом сеть. Индекс — это пять шардов по 400 КБ: без
   копии каждый запуск начинался с нескольких секунд пустого экрана, а без сети
   вместо памяти показывалась ошибка. Теперь граф появляется сразу, а свежий
   индекс подменяет модель фоном — молча, если ничего не изменилось. */
async function boot() {
  const s = currentSettings();
  initTransport(s);
  view.innerHTML = `<div class="splash"><span class="gem"></span><span class="st" id="boot-st">ПОДКЛЮЧАЮСЬ…</span></div>`;

  const cache = await loadIndexCache(cacheKey(s));
  let shown = false;
  if (cache?.chunks?.length) {
    applyModel(buildModel(cache.chunks, cache.meta, cache.synonyms), { fromCache: cache.at });
    state.offline = fmtAge(cache.at);
    shown = true;
    route();
    startChannel();
  }

  try {
    const raw = await fetchIndex(msg => { const b = $('#boot-st'); if (b) b.textContent = msg.toUpperCase(); });
    applyModel(buildModel(raw.chunks, raw.meta, raw.synonyms));
    state.offline = null;
    saveIndexCache(cacheKey(s), raw);
  } catch (e) {
    if (shown) {                       // копия уже на экране — сеть подождёт
      toast(`СВЕЖИЙ ИНДЕКС НЕ ПРИШЁЛ: ${(e.message || e).toString().toUpperCase()} · ПОКАЗАНА ОФЛАЙН-КОПИЯ`, 'warn', 6000);
      return;
    }
    view.innerHTML = `<div class="splash"><span class="gem" style="animation:none;background:#e86450;box-shadow:0 0 14px rgba(232,100,80,.7)"></span>
      <span class="st">КОРПУС НЕ ЗАГРУЗИЛСЯ: ${(e.message || e).toString().toUpperCase()}</span>
      <button class="btn-line" id="boot-retry">ПОВТОРИТЬ</button>
      <button class="btn-line" id="boot-reset">СМЕНИТЬ ПОДКЛЮЧЕНИЕ</button></div>`;
    $('#boot-retry').addEventListener('click', boot);
    $('#boot-reset').addEventListener('click', resetConnection);
    return;
  }

  if (shown) { if (state.graph) state.graph.setModel(corpus); route(); }
  else { startChannel(); route(); }
  drainQueue();
  handleLaunchParams();
}

/* ── запуск приложения с параметрами ───────────────────────────────────────
   Установленное приложение открывают не только с иконки: ярлык «быстрая мысль»
   и системное «поделиться» приходят сюда же, но с query. Разбираем один раз и
   чистим адрес, чтобы перезагрузка не повторяла действие. */
const SHARE_KEY = 'shards.pending-share';

// Вызывается и до подключения (тогда только запоминает), и после загрузки
// корпуса (тогда открывает окно мысли).
export function stashLaunchParams() {
  const p = new URLSearchParams(location.search);
  if (!p.has('action') && !p.has('text') && !p.has('title') && !p.has('url')) return;
  const shared = [p.get('title'), p.get('text'), p.get('url')].filter(Boolean).join(' — ');
  // Текст, присланный из другого приложения, нельзя терять на экране входа —
  // кладём до лучших времён и чистим адрес, чтобы перезагрузка не повторяла.
  try { sessionStorage.setItem(SHARE_KEY, JSON.stringify({ shared, action: p.get('action') || '' })); } catch {}
  history.replaceState(null, '', location.pathname + location.hash);
}

function handleLaunchParams() {
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(SHARE_KEY)); sessionStorage.removeItem(SHARE_KEY); } catch {}
  if (!pending) return;
  if (pending.action === 'capture' || pending.shared) setTimeout(() => state.capture.open(pending.shared), 200);
}

/* ── очередь записей ── */
async function drainQueue() {
  const left = await pendingWrites();
  if (!left) return updateQueueChip(0);
  updateQueueChip(left);
  const { sent, left: rest } = await flushQueue({
    onFailed: (it, e) => toast(`ЗАПИСЬ ИЗ ОЧЕРЕДИ НЕ ПРОШЛА: ${e.message}`, 'err', 7000),
  });
  if (sent) toast(`ДОСЛАНО ЗАПИСЕЙ: ${sent}`);
  updateQueueChip(rest);
}
function updateQueueChip(n) {
  const el = $('#top-queue');
  el.hidden = !n;
  el.textContent = n ? `В ОЧЕРЕДИ ${n}` : '';
}

const currentSettings = () => getSettings();

// Ключ офлайн-копии. У локального вальта нет URL, поэтому копии всех вальтов
// сваливались в одну запись: демо-вальт показывал боевые заметки, мини-вальт —
// чужой граф. Ключ должен различать источник, а не только адрес.
const cacheKey = s => s?.demo ? 'demo' : s?.native ? `native:${s.vaultPath || ''}` : s?.url;
function resetConnection() {
  if (state.channel) state.channel.stop();
  clearSettings();
  location.hash = ''; showConnect();
}
function showConnect() {
  setWs('dead', 'НЕТ СВЯЗИ');
  renderConnect(view, () => { boot(); });
  setBar('PWA · РАБОТАЕТ ОФЛАЙН С ПОСЛЕДНИМИ ДАННЫМИ');
}

/* ── живой канал ── */
function startChannel() {
  if (state.channel) state.channel.stop();
  const ch = liveChannel(currentSettings());
  state.channel = ch;
  ch.onStatus = st => {
    if (st === 'live') { setWs('live', 'WS ЖИВОЙ'); drainQueue(); }
    else if (st === 'retry' || st === 'connecting') setWs('retry', 'ПЕРЕПОДКЛЮЧЕНИЕ…');
    else if (st === 'dead') setWs('dead', 'НЕТ СВЯЗИ');
    else setWs('dead', 'НЕТ СВЯЗИ');
  };
  ch.onEvent = ev => {
    notePush(ev);
    toast(`PUSH ${ev.sha?.slice(0, 6) || ''} · ${ev.message || ''} · ${ev.paths?.length || 0} ФАЙЛ.`);
    // открытая заметка из paths — перечитать
    const m = location.hash.match(/^#\/note\/(.+)$/);
    if (m && ev.paths?.includes(decodeURIComponent(m[1]))) {
      if (!document.querySelector('.editor')) renderNote(view, decodeURIComponent(m[1]));
      else toast('ЭТА ЗАМЕТКА ИЗМЕНЕНА НА ДРУГОМ УСТРОЙСТВЕ — СОХРАНЕНИЕ МОЖЕТ ДАТЬ КОНФЛИКТ', 'warn', 7000);
    }
    // перезагрузка корпуса: сразу или после пересборки индекса
    clearTimeout(state.reloadTimer);
    state.reloadTimer = setTimeout(refreshCorpus, ev.indexTouched ? 800 : INDEX_REBUILD_MS);
  };
  ch.start();
}
async function refreshCorpus() {
  const s = currentSettings();
  try {
    const raw = await fetchIndex(() => {});
    applyModel(buildModel(raw.chunks, raw.meta, raw.synonyms));
    state.offline = null;
    saveIndexCache(s.demo ? 'demo' : s.url, raw);
    toast('КОРПУС ОБНОВЛЁН');
    if (state.graph) state.graph.setModel(corpus);
    drawStrip(($('.tab.on') || {}).dataset?.r || 'graph');
    if (/^#\/cards/.test(location.hash)) route();
  } catch { toast('НЕ СМОГ ОБНОВИТЬ КОРПУС', 'warn'); }
}

/* ── клавиатура ── */
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape' && !typing) {
    if ($('#capture').classList.contains('open') || $('#modal').classList.contains('open')) return;
    if (/^#\/note/.test(location.hash)) { location.hash = '#/graph'; return; }
  }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); location.hash = '#/search'; setTimeout(() => $('#s-q')?.focus(), 60); }
  else if (e.code === 'KeyN') { e.preventDefault(); state.capture.open(); }
  else if (e.code === 'KeyC') { e.preventDefault(); state.creator.open(); }
  else if (e.code === 'KeyG') location.hash = '#/graph';
  else if (e.code === 'KeyK') location.hash = '#/cards';
  else if (state.graph && /^#\/graph|^$|^#\/$/.test(location.hash || '')) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
      if (state.graph.key(e)) e.preventDefault();
    }
  }
});

/* ── возврат на вкладку после простоя ── */
let hiddenAt = null;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else {
    if (state.channel) state.channel.kick && state.channel.kick();
    if (hiddenAt && Date.now() - hiddenAt > 120000 && corpus.loadedAt) refreshCorpus();
  }
});

window.addEventListener('resize', () => state.graph && state.graph.resize());
window.addEventListener('hashchange', route);

/* ── старт ── */
$('#tabs').querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => { location.hash = `#/${t.dataset.r}`; }));
$('#btn-capture').addEventListener('click', () => state.capture.open());
$('#btn-new').addEventListener('click', () => state.creator.open());
$('#btn-conn').addEventListener('click', resetConnection);
state.capture = initCapture();
state.creator = initNoteCreator();

stashLaunchParams();   // до всего: ярлык и «поделиться» приходят с query

/* ── десктоп ──────────────────────────────────────────────────────────────
   В приложении вальт лежит на диске: если папка уже выбрана, спрашивать нечего —
   стартуем сразу. Команды из трея и глобальный хоткей приходят сюда же. */
if (IS_NATIVE) {
  document.documentElement.classList.add('native');
  window.shardsNative.onCapture(() => state.capture.open());
  window.shardsNative.onRoute(hash => { location.hash = hash; });
  window.shardsNative.onVaultPicked(path => { saveSettings({ native: true, vaultPath: path }); boot(); });

  window.shardsNative.state().then(st => {
    if (st.ready) { saveSettings({ native: true, vaultPath: st.path }); boot(); }
    else showConnect();
  });
} else {
  const s = getSettings();
  if (s) boot();
  else if (!IS_APP) { saveSettings({ demo: true }); boot(); }   // песочница предпросмотра — сразу демо
  else showConnect();
}
