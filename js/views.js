// Экраны: подключение, граф, заметка, картотека, поиск + быстрая мысль + тосты.
import { tools, isConflict, getSettings, saveSettings, clearSettings, initTransport, AuthError, NetError, IS_NATIVE } from './api.js';
import { corpus, resolveWiki, searchCorpus, textOf, isVisible } from './corpus.js';
import { withSnippets, noteText, forgetText } from './map.js';
import { markTerms, queryTerms, parseSynonyms, parseServerSearch } from './search.js';
import { splitFrontmatter, parseSections, renderMd, fmtBytes, fmtAge, plural } from './md.js';
import { GraphView } from './graph.js';
import { DEFAULT_URL, DAILY_THOUGHTS, MODEL } from './config.js';
import { buildContext, packForChat, askClaude, callClaude, getAiSettings, saveAiSettings, forgetKey, mcpConfig, MODES, HELPERS, packHelper } from './ai.js';
import { appendThought, dailyPath, createNote, safeFileName, addSection, patchSection, TEMPLATES, toggleTag, linkTo, unlinkFrom, renameTag, setNoteField } from './write.js';
import { LINK_TYPES, TYPE_OF_FIELD, FIELD_OF_TYPE } from './frontmatter.js';
import { parseQuery, filterNotes, matches, hasFilters, describe, FIELDS } from './query.js';
import { diffLines, collapseSame } from './diff.js';
import { similarTo, buildClusters } from './similar.js';
import { initVectors, embedQuery, getEmbedSettings, saveEmbedSettings, vecState } from './vectors.js';
import { entityAnswer, entityStats, entityIndex, claimsOf } from './entities.js';

export const $ = (sel, el = document) => el.querySelector(sel);
export const el = (tag, cls, html) => { const d = document.createElement(tag); if (cls) d.className = cls; if (html != null) d.innerHTML = html; return d; };
const norm2 = s => String(s).toLowerCase().replace(/ё/g,'е').trim();
const escA = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
// подпись созвездия: человеческое имя из словаря, а не путь папки
const zn = note => note?.zoneRef?.label || (note?.zone || '').toUpperCase();

export function toast(msg, kind = '', ms = 4200) {
  const t = el('div', `toast ${kind}`, `<i></i><span>${msg}</span>`);
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350); }, ms);
}

export const zoneDot = z => `<span class="dot glow" style="background:${z.color};color:${z.color}"></span>`;
const noteHref = n => `#/note/${encodeURIComponent(n.path)}`;
const openNote = n => location.hash = noteHref(n);

export function wireWikiLinks(root) {
  root.querySelectorAll('a.wiki').forEach(a => {
    const t = resolveWiki(a.dataset.wiki);
    if (!t) { a.classList.add('broken'); a.title = 'заметка не найдена'; }
    a.addEventListener('click', () => t ? openNote(t) : toast(`нет заметки «${a.dataset.wiki}» — ищу…`, 'warn') || (location.hash = `#/search?q=${encodeURIComponent(a.dataset.wiki)}`));
  });
}

/* ── подключение ─────────────────────────────────────────── */

// В приложении на своей машине вальт — это папка, а не адрес с секретом.
// Спрашиваем ровно одно: где она лежит.
function renderConnectNative(root, onDone) {
  root.innerHTML = `<div class="conn-wrap"><div class="conn">
    <div class="hd"><span class="gem"></span><b>ОСКОЛКИ</b><span>ПЕРВЫЙ ЗАПУСК</span></div>
    <div class="bd">
      <div style="font-size:11.5px;color:var(--mid);line-height:1.9">Приложение читает и пишет вальт прямо с диска: без интернета, без воркера и без секрета. Укажите папку с заметками — ту, где лежат <b style="color:var(--text)">daily</b> и <b style="color:var(--text)">_машина/индекс</b>.</div>
      <div class="status" id="c-status" hidden></div>
      <button class="go" id="c-pick">ВЫБРАТЬ ПАПКУ ВАЛЬТА</button>
      <div class="ft"><span>синхронизация остаётся за git — приложение видит правки сразу</span><span class="demo" id="c-demo">ДЕМО БЕЗ ВАЛЬТА</span></div>
    </div></div></div>`;
  const st = $('#c-status', root);
  $('#c-pick', root).addEventListener('click', async () => {
    const path = await window.shardsNative.pick();
    if (!path) return;
    st.hidden = false; st.className = 'status ok';
    st.innerHTML = `<span class="dot glow" style="background:currentColor"></span><span>ВАЛЬТ НАЙДЕН · ${path.toUpperCase()}</span>`;
    saveSettings({ native: true });
    setTimeout(onDone, 400);
  });
  $('#c-demo', root).addEventListener('click', () => { saveSettings({ demo: true }); onDone(); });
}

export function renderConnect(root, onDone) {
  if (IS_NATIVE) return renderConnectNative(root, onDone);
  root.innerHTML = `<div class="conn-wrap"><div class="conn">
    <div class="hd"><span class="gem"></span><b>SHARDS</b><span>ПЕРВЫЙ ЗАПУСК</span></div>
    <div class="bd">
      <div><div class="lbl" style="display:block;margin-bottom:7px">URL ВОРКЕРА</div><input id="c-url" value="${escA(getSettings()?.url || DEFAULT_URL)}" spellcheck="false"></div>
      <div><div class="lbl" style="display:block;margin-bottom:7px">СЕКРЕТ</div><input id="c-sec" type="password" placeholder="••••••••" spellcheck="false">
        <div style="font-size:9px;color:#454c60;margin-top:6px">хранится только на этом устройстве · в репозиторий не попадает</div></div>
      <div class="status" id="c-status" hidden></div>
      <button class="go" id="c-go">ПРОВЕРИТЬ И ВОЙТИ</button>
      <div class="ft"><span>ping различает «нет сети» и «неверный секрет»</span><span class="demo" id="c-demo">ДЕМО БЕЗ ПОДКЛЮЧЕНИЯ</span></div>
    </div></div></div>`;
  const st = $('#c-status', root);
  const show = (cls, msg) => { st.hidden = false; st.className = `status ${cls}`; st.innerHTML = `<span class="dot glow" style="background:currentColor"></span><span>${msg}</span>`; };
  async function go() {
    const url = $('#c-url', root).value.trim(), secret = $('#c-sec', root).value;
    if (!/\/mcp\/?$/.test(url)) return show('bad', 'URL должен оканчиваться на /mcp');
    show('', 'PING…');
    const t0 = performance.now();
    try {
      initTransport({ url, secret });
      await (await import('./api.js')).transport.ping();
      show('ok', `PING → PONG · ${Math.round(performance.now() - t0)} МС · ВАЛЬТ ДОСТУПЕН`);
      saveSettings({ url, secret, demo: false });
      setTimeout(onDone, 500);
    } catch (e) {
      if (e instanceof AuthError) show('bad', 'АДРЕС ИЛИ СЕКРЕТ НЕВЕРНЫ');
      else show('bad', 'НЕТ СЕТИ ИЛИ ВОРКЕР НЕДОСТУПЕН');
    }
  }
  $('#c-go', root).addEventListener('click', go);
  root.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#c-demo', root).addEventListener('click', () => { saveSettings({ demo: true }); onDone(); });
}

/* ── граф ────────────────────────────────────────────────── */
let lastPush = null;
export function notePush(ev) { lastPush = { ...ev, at: Date.now() }; drawSyncChip(); }
function drawSyncChip() {
  const chip = document.getElementById('g-sync');
  if (!chip) return;
  if (!lastPush) { chip.hidden = true; return; }
  chip.hidden = false;
  const p = (lastPush.paths && lastPush.paths[0]) || lastPush.message || '';
  chip.innerHTML = `<i></i><span>КОММИТ ${(lastPush.sha || '').slice(0, 6).toUpperCase()} · ${p}</span><span class="ago">${fmtAge(new Date(lastPush.at).toISOString()).toUpperCase()}</span>`;
}
let graph = null;
export function renderGraph(root, state) {
  root.innerHTML = `<div class="graph-wrap">
    <div class="dock">
      <div class="blk"><span class="lbl">ЧТО ПОКАЗЫВАТЬ</span><div class="seg">
        <button class="chip on" data-scope="all" title="весь корпус, включая журналы сессий и очередь заданий">ВСЁ</button>
        <button class="chip" data-scope="notes" title="без журналов и очереди: остаются заметки, которые чему-то посвящены">ТОЛЬКО ЗАМЕТКИ</button></div></div>
      <div class="blk"><span class="lbl">РАСКЛАДКА</span>
        <button class="radio on" data-layout="zones">▸ КЛАСТЕРЫ / ЗОНЫ</button>
        <button class="radio" data-layout="force">&nbsp;&nbsp;СИЛОВАЯ</button>
        <button class="radio" data-layout="fresh">&nbsp;&nbsp;СВЕЖЕСТЬ</button>
        <button class="radio" data-layout="deps" title="слои по depends_on и blocks: что раньше, что позже, где циклы">&nbsp;&nbsp;ЗАВИСИМОСТИ</button>
        <button class="radio" data-layout="clusters" title="группы по смыслу: считаются из графа связей, а не из папок">&nbsp;&nbsp;СМЫСЛ</button></div>
      <div class="blk"><span class="lbl">ОБЗОР</span><div class="seg">
        <button class="chip" data-fold title="свернуть созвездия в объекты: на большой карте видно, что с чем связано, а физика не считается вовсе">◈ СВЕРНУТЬ</button>
        <button class="chip" data-ego title="показывать только окрестность выбранного узла — два шага по связям">◎ ОКРЕСТНОСТЬ</button></div></div>
      <div class="blk"><span class="lbl">КОДИРОВКА</span>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
          <button class="chip on" data-color="zone">ЗОНА</button><button class="chip" data-color="fresh">СВЕЖ</button><button class="chip" data-color="deg">СВЯЗ</button></div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="chip on" data-size="bytes">ОБЪЁМ</button><button class="chip" data-size="deg">СВЯЗИ</button><button class="chip" data-size="commits">ПРАВКИ</button></div></div>
      <div class="blk"><span class="lbl">СЛОИ</span><div id="g-layers" style="display:flex;gap:5px;flex-wrap:wrap"></div></div>
      <div class="blk" id="g-cl-blk" hidden><span class="lbl">СОЗВЕЗДИЯ ПО СМЫСЛУ</span><div id="g-clusters"></div></div>
      <div class="blk"><span class="lbl">ЗОНЫ</span><div id="g-zones"></div></div>
      <div class="blk"><span class="lbl">ФИЛЬТР</span><input id="g-filter" placeholder="имя_заметки…" spellcheck="false"></div>
      <div class="foot" id="g-foot"></div>
    </div>
    <div class="viewport" id="g-vp">
      <canvas id="g-canvas" tabindex="0"></canvas>
      <div class="tooltip" id="g-tip" hidden></div>
      <div class="readout" id="g-read" hidden></div>
      <div class="sync-chip" id="g-sync" hidden></div>
      ${state.offline ? `<div class="offline-note">ОФЛАЙН-КОПИЯ · ИНДЕКС ${state.offline.toUpperCase()}</div>` : ''}
    </div></div>`;

  const tip = $('#g-tip', root), read = $('#g-read', root);
  const showRead = note => {
    if (!note) { read.hidden = true; return; }
    read.hidden = false;
    read.innerHTML = `<div class="hd">УЗЕЛ // ВЫБРАН</div><div class="bd">
      ПУТЬ&nbsp;&nbsp;&nbsp;<b>${note.path}</b><br>
      ЗОНА&nbsp;&nbsp;&nbsp;<span style="color:${note.zoneRef.color}" title="${escA(note.zone)}">${zn(note)}</span><br>
      ПРАВКА&nbsp;<b>${fmtAge(note.meta.h).toUpperCase()}</b> · ОБЪЁМ <b>${fmtBytes(note.meta.b)}</b><br>
      СВЯЗИ&nbsp;&nbsp;<b>${note.deg}</b> · КОММИТОВ <b>${note.meta.c}</b><br>
      <span class="act" data-open>[ENTER] ОТКРЫТЬ</span></div>`;
    $('[data-open]', read).addEventListener('click', () => openNote(note));
  };

  if (graph) graph.stop();
  graph = new GraphView($('#g-canvas', root), corpus, {
    onHover(note, x, y) {
      if (!note) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.style.left = Math.min(x + 16, $('#g-vp', root).clientWidth - 270) + 'px';
      tip.style.top = (y + 14) + 'px';
      tip.innerHTML = `<div class="t">${note.title}</div><div class="m">${zn(note)} · правка ${fmtAge(note.meta.h)}<br>${fmtBytes(note.meta.b)} · ${note.deg} ${plural(note.deg, 'связь', 'связи', 'связей')}</div><div class="go">КЛИК — ВЫБРАТЬ · ДВАЖДЫ — ОТКРЫТЬ</div>`;
    },
    onSelect: showRead,
    onOpen: openNote,
    // Клик по свёрнутому созвездию разворачивает именно его: с общего плана
    // проваливаешься внутрь, а не разворачиваешь всю карту обратно.
    onCluster(s) {
      graph.collapse(false);
      $('[data-fold]', root).classList.remove('on');
      if (graph.layout === 'clusters') {
        graph.focusCluster = s.i;
        graph.refreshFilter(); graph._userMoved = false; graph.settle(200);
        toast(`СОЗВЕЗДИЕ «${s.label}» · ${s.m} ${plural(s.m, 'ЗАМЕТКА', 'ЗАМЕТКИ', 'ЗАМЕТОК')} · ESC — НАЗАД КО ВСЕЙ КАРТЕ`, '', 5000);
      }
    },
  });
  state.graph = graph;

  // Кластеры считаются один раз и лениво: они нужны только тем, кто открыл
  // раскладку «смысл» или свёртку, а на старте графа это лишняя работа.
  const withClusters = async () => {
    const cl = await buildClusters();      // сам кэширует и пересчитывает после нового индекса
    if (cl !== graph.clusters) graph.setClusters(cl);
    drawClusters(cl);
    return cl;
  };
  // Список созвездий сбоку: клик — остаться внутри одного, ✦ — попросить ИИ
  // назвать его по-человечески и сказать, что в нём лежит не на месте.
  const drawClusters = cl => {
    const blk = $('#g-cl-blk', root), box = $('#g-clusters', root);
    blk.hidden = false;
    box.innerHTML = cl.list.map((c, i) => `<button class="zrow" data-c="${i}" title="${escA(c.label)}">
      <span class="nm">${escA(c.label.length > 26 ? c.label.slice(0, 24) + '…' : c.label)}</span>
      <span class="ct">${c.size}</span><span class="ct" data-ai-c="${i}" style="color:var(--amber);cursor:pointer" title="описать созвездие">✦</span></button>`).join('');
    box.querySelectorAll('[data-c]').forEach(b => b.addEventListener('click', e => {
      if (e.target.dataset.aiC !== undefined) { aiCluster(cl.list[+e.target.dataset.aiC]); return; }
      const i = +b.dataset.c;
      graph.focusCluster = graph.focusCluster === i ? null : i;
      box.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', +x.dataset.c === graph.focusCluster));
      graph.refreshFilter(); graph._userMoved = false; graph.settle(200);
    }));
  };

  const zonesBox = $('#g-zones', root);
  const drawZones = () => {
    zonesBox.innerHTML = corpus.zones.map((z, i) => `<button class="zrow ${z.on ? 'on' : ''}" data-z="${i}" title="${escA(z.name)}${z.chronicle ? ' · хроника: упоминает всё подряд, поэтому приглушена' : ''}">
      <span class="box"></span>${zoneDot(z)}<span class="nm">${z.label}</span><span class="ct">${z.count}</span></button>`).join('');
    zonesBox.querySelectorAll('.zrow').forEach(b => b.addEventListener('click', () => {
      const z = corpus.zones[+b.dataset.z]; z.on = !z.on; drawZones(); graph.refreshFilter();
    }));
  };
  // Слои — это `type` заметки: note, person, task, card… Карточки словаря
  // выключены по умолчанию, иначе они одни забивают всю карту.
  const layersBox = $('#g-layers', root);
  const drawLayers = () => {
    layersBox.innerHTML = corpus.layers.map((l, i) =>
      `<button class="chip ${l.on ? 'on' : ''}" data-l="${i}" title="тип заметки из фронтматтера">${l.name.toUpperCase()} ${l.count}</button>`).join('');
    layersBox.querySelectorAll('[data-l]').forEach(b => b.addEventListener('click', () => {
      const l = corpus.layers[+b.dataset.l]; l.on = !l.on;
      drawLayers(); graph.refreshFilter(); graph.fit(); graph.heat(.3);
      $('#g-foot', root).innerHTML = foot();
    }));
  };
  drawLayers();
  drawZones();
  const foot = () => {
    const vis = corpus.notes.filter(isVisible).length;
    return `УЗЛОВ ${vis} ИЗ ${corpus.notes.length} · РЁБЕР ${corpus.edges.length}<br>`
      + `${corpus.fromMap ? 'КАРТА' : 'ИНДЕКС'} ${corpus.loadedAt ? corpus.loadedAt.toLocaleTimeString('ru') : '—'}<br>ПЕРЕСБОРКА ~30 С ПОСЛЕ ПУША`;
  };
  $('#g-foot', root).innerHTML = foot();

  root.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', async () => {
    root.querySelectorAll('[data-layout]').forEach(x => { x.classList.remove('on'); x.innerHTML = '&nbsp;&nbsp;' + x.textContent.trim().replace(/^▸ /, ''); });
    b.classList.add('on'); b.innerHTML = '▸ ' + b.textContent.trim();
    if (b.dataset.layout === 'clusters') {
      const cl = await withClusters();
      if (!cl?.list.length) { toast('КЛАСТЕРЫ НЕ СЧИТАЮТСЯ: В КОРПУСЕ НЕТ СВЯЗЕЙ', 'warn'); return; }
      toast(`СОЗВЕЗДИЙ ПО СМЫСЛУ: ${cl.list.length} · САМОЕ КРУПНОЕ «${cl.list[0].label}» (${cl.list[0].size})`, '', 6000);
    }
    graph.focusCluster = null;
    graph.set({ layout: b.dataset.layout });
    graph.settle(300);
    if (b.dataset.layout === 'deps') {
      const vis = graph.nodes.filter(n => !n.dim).length;
      const cyc = graph._cycles?.size || 0;
      toast(vis
        ? `ЗАВИСИМОСТЕЙ: ${vis} ${plural(vis, 'ЗАМЕТКА', 'ЗАМЕТКИ', 'ЗАМЕТОК')}${cyc ? ` · ЦИКЛОВ: ${cyc}` : ''}`
        : 'ЗАВИСИМОСТЕЙ ПОКА НЕТ — ПОСТАВЬТЕ СВЯЗЬ «ЗАВИСИТ ОТ» НА ЭКРАНЕ ЗАМЕТКИ', vis ? '' : 'warn', 6000);
    }
  }));
  const wireChips = (attr, prop) => root.querySelectorAll(`[data-${attr}]`).forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.remove('on')); b.classList.add('on');
    graph.set({ [prop]: b.dataset[attr] });
  }));
  wireChips('color', 'colorBy'); wireChips('size', 'sizeBy');
  // Журналы и очередь — 85 узлов из 209: они упоминают всё подряд, поэтому и в
  // поиске весят 0.4, и на карте гасятся одним нажатием, когда нужен смысл, а не хроника.
  root.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-scope]').forEach(x => x.classList.toggle('on', x === b));
    const onlyNotes = b.dataset.scope === 'notes';
    corpus.zones.forEach(z => { if (z.chronicle) z.on = !onlyNotes; });
    drawZones(); graph.refreshFilter(); graph.fit(); graph.heat(.35);
  }));
  $('#g-filter', root).addEventListener('input', e => { graph.filterText = e.target.value; graph.refreshFilter(); });

  $('[data-fold]', root).addEventListener('click', async e => {
    const btn = e.currentTarget;          // после await currentTarget уже null — событие отработало
    const on = !btn.classList.contains('on');
    // Свёртка по смыслу требует кластеров; в остальных раскладках сворачиваем
    // по зонам — это те же созвездия, что человек уже видит на карте.
    const by = graph.layout === 'clusters' ? 'cluster' : 'zone';
    if (on && by === 'cluster') await withClusters();
    btn.classList.toggle('on', on);
    graph.focusCluster = null; graph.refreshFilter();
    graph.collapse(on, by);
    if (on) toast(`СВЁРНУТО В ${graph.superNodes.length} ${plural(graph.superNodes.length, 'ОБЪЕКТ', 'ОБЪЕКТА', 'ОБЪЕКТОВ')} · КЛИК — РАЗВЕРНУТЬ ОДНО`, '', 5000);
    else graph.settle(250);
  });
  $('[data-ego]', root).addEventListener('click', e => {
    const on = !e.currentTarget.classList.contains('on');
    e.currentTarget.classList.toggle('on', on);
    graph.set({ scope: on ? 'ego' : 'all' });
    graph.settle(200);
    if (on && !graph.selected) toast('ВЫБЕРИТЕ УЗЕЛ — ПОКАЖУ ЕГО ОКРЕСТНОСТЬ НА ДВА ШАГА', 'warn');
  });

  graph.start();
  drawSyncChip();
  window.__shards_graph = graph;
  return graph;
}

/* ── заметка ─────────────────────────────────────────────── */
// Текст заметки уже лежит в корпусе — значит открывать её по сети незачем:
// рисуем сразу из индекса и молча подменяем свежей версией, когда та придёт.
// Ожидание сети остаётся только там, где без неё нельзя: правка раздела.
export async function renderNote(root, path) {
  const note = corpus.byPath.get(path);
  root.innerHTML = `<div class="note-wrap"><div class="note-cols">
    <div class="note-main" id="n-main"><div class="splash" style="position:static;padding:60px 0"><span class="gem"></span><span class="st">ЧИТАЮ ЗАМЕТКУ…</span></div></div>
    <div class="note-rail" id="n-rail"></div></div></div>`;

  // Прочитанное однажды показываем мгновенно из кэша, а свежесть догоняем следом:
  // на диске это неразличимо, по сети — разница между «сразу» и «через полсекунды».
  let shown = false;
  if (note?.text) { drawNote(root, path, note.text, note, true); shown = true; }

  let raw;
  try { raw = await textOf(note || path); }
  catch (e) {
    if (shown) return;
    $('#n-main', root).innerHTML = `<div class="conflict">Не удалось прочитать «${path}»: ${e.message}</div>`;
    return;
  }
  const sameBody = shown && splitFrontmatter(raw).body.replace(/\s+/g, ' ').trim() === note.text.replace(/\s+/g, ' ').trim();
  if (!sameBody) drawNote(root, path, raw, note, false);
}

function drawNote(root, path, raw, note, offline) {
  const { fm, body } = splitFrontmatter(raw);
  const sections = parseSections(body);
  const main = $('#n-main', root), rail = $('#n-rail', root);
  const title = note?.title || path.replace(/\.md$/, '').split('/').pop();
  main.innerHTML = `
    <h1 class="note-title">${title}</h1>
    <div class="note-meta">
      ${note ? `<span style="color:${note.zoneRef.color}" title="${escA(note.zone)}">■ ${zn(note)}</span>` : ''}
      <span>ПРАВКА ${fmtAge(note?.meta.h).toUpperCase()}</span><span>${fmtBytes(note?.meta.b || raw.length)}</span>
      <span>${note?.meta.c || 0} ${plural(note?.meta.c || 0, 'КОММИТ', 'КОММИТА', 'КОММИТОВ')}</span><span>${note?.deg || 0} ${plural(note?.deg || 0, 'СВЯЗЬ', 'СВЯЗИ', 'СВЯЗЕЙ')}</span>
      ${offline ? '<span style="color:#e8b84b">ОФЛАЙН-КОПИЯ ИЗ ИНДЕКСА</span>' : ''}</div>
    ${fm ? `<details class="fm"><summary>FRONTMATTER · ${fm.split('\n').length} ${plural(fm.split('\n').length, 'СТРОКА', 'СТРОКИ', 'СТРОК').toUpperCase()}</summary><pre>${fm.replace(/</g, '&lt;')}</pre></details>` : ''}
    <div id="n-sections"></div>`;
  const secBox = $('#n-sections', main);
  sections.forEach((s, i) => {
    const d = el('div', 'sect');
    d.innerHTML = `${s.heading ? `<div class="sect-hd"><span class="hash">${'#'.repeat(s.level)}</span>${s.level <= 2 ? `<h2 id="h-${i}">${s.heading}</h2>` : `<h3 id="h-${i}">${s.heading}</h3>`}<span class="edit" data-i="${i}">[E] ПРАВИТЬ</span></div>` : ''}
      <div class="md">${renderMd(s.body)}</div>`;
    secBox.appendChild(d);
    const btn = $('.edit', d);
    if (btn) btn.addEventListener('click', () => editSection(d, path, s, () => renderNote(root, path)));
  });
  const addBox = el('div', 'sect');
  addBox.innerHTML = `<button class="btn-line" data-add>＋ РАЗДЕЛ</button>`;
  secBox.appendChild(addBox);
  $('[data-add]', addBox).addEventListener('click', () => {
    if (!$('.editor', addBox)) newSection(addBox, path, () => renderNote(root, path));
  });
  wireWikiLinks(main);

  drawRail(root, rail, note, sections, () => renderNote(root, path), path);
}

/* Утверждения о сущности — то, ради чего вся схема и затевалась.

   У сущности («Ксюша», «pbcheck», «Ереван») сама заметка почти ничего не
   содержит: это якорь, а не текст. Знание о ней рассыпано по осколкам, и здесь
   оно собирается обратно — по видам и по времени, свежее сверху.

   Отменённое не прячется, а показывается зачёркнутым: то, что решение
   когда-то было другим, — тоже знание, и молча стирать его нельзя.

   Для самого осколка панель показывает его паспорт: тип, дату, статус,
   уверенность. Это те четыре вещи, по которым видно, можно ли на него
   опираться сегодня. */
const CLAIM_ORDER = ['решение', 'правило', 'договорённость', 'намерение', 'факт', 'наблюдение', 'событие'];

function claimsPanel(note) {
  if (!note) return '';

  if (note.klass === 'утверждение' || note.klass === 'событие') {
    const dead = note.status === 'отменено' || note.status === 'устарело';
    return `<div class="panel"><div class="hd">ПАСПОРТ УТВЕРЖДЕНИЯ</div><div class="bd" style="padding:10px 12px;font-size:10px;color:var(--mid);line-height:2">
      ВИД&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b style="color:var(--text);font-weight:400">${escA((note.kind || '—').toUpperCase())}</b><br>
      КОГДА&nbsp;&nbsp;&nbsp;<b style="color:var(--text);font-weight:400">${escA(note.when || '—')}</b><br>
      СТАТУС&nbsp;&nbsp;<b style="color:${dead ? 'var(--red)' : 'var(--green)'};font-weight:400">${escA((note.status || '—').toUpperCase())}</b><br>
      ОПОРА&nbsp;&nbsp;&nbsp;<b style="color:var(--text);font-weight:400">${escA((note.confidence || '—').toUpperCase())}</b>
    </div></div>`;
  }

  const claims = (note.backlinks || []).filter(l => l.type === 'about').map(l => l.from);
  if (!claims.length) return '';
  const byKind = new Map();
  for (const c of claims) {
    const k = c.kind || 'прочее';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(c);
  }
  const order = [...byKind.keys()].sort((a, b) => {
    const ia = CLAIM_ORDER.indexOf(a), ib = CLAIM_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return `<div class="panel"><div class="hd">УТВЕРЖДЕНИЯ · ${claims.length}</div>
    ${order.map(kind => {
      const list = byKind.get(kind).sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
      return `<div class="rail-group"><span class="lbl">${escA(kind.toUpperCase())}</span><div class="rail-rows">${
        list.map(c => {
          const dead = c.status === 'отменено' || c.status === 'устарело';
          // Дата уже стоит справа отдельной колонкой — в имени она лишняя.
          const nm = c.title.replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
          return `<div data-p="${escA(c.path)}" title="${escA(c.status || '')}">${zoneDot(c.zoneRef)}
            <span class="nm" style="${dead ? 'text-decoration:line-through;opacity:.55' : ''}">${nm}</span>
            <span class="zn">${escA(String(c.when || '').slice(0, 10))}</span></div>`;
        }).join('')}</div></div>`;
    }).join('')}</div>`;
}

/* Правая рельса: свойства, связи по типам, обратные связи, оглавление.

   Раньше здесь были только метаданные и плоский список «на это ссылаются». На
   двух сотнях заметок этого хватало; на десяти тысячах вопрос не «кто ссылается»,
   а «чем связаны»: что из чего следует, что чем заблокировано, что устарело. */
function drawRail(root, rail, note, sections, reload, path) {
  const backs = note ? note.backlinks || [] : [];
  const byType = list => {
    const m = new Map();
    for (const l of list) { const k = l.type || 'link'; if (!m.has(k)) m.set(k, []); m.get(k).push(l); }
    return m;
  };
  const typeLabel = t => (LINK_TYPES.find(x => TYPE_OF_FIELD[x.key] === t) || {}).label || 'ССЫЛКИ';
  const out = byType(note?.links || []);
  const back = byType(backs);

  const linkRows = (items, dir) => items.map(l => {
    const other = dir === 'out' ? l.to : l.from;
    return `<div data-p="${escA(other.path)}">${zoneDot(other.zoneRef)}<span class="nm">${other.title}</span>${
      dir === 'out' && l.type !== 'link' ? `<span class="zn" data-unlink="${escA(l.type)}|${escA(other.title)}" title="убрать связь">✕</span>` : `<span class="zn">${zn(other)}</span>`}</div>`;
  }).join('');

  rail.innerHTML = `
    <div class="panel"><div class="hd">СВОЙСТВА</div><div class="bd" style="padding:10px 12px">
      <div style="font-size:10px;color:var(--mid);line-height:2">
        ТИП&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b style="color:var(--text);font-weight:400">${(note?.type || '—').toUpperCase()}</b>
        · СТАТУС <b style="color:var(--text);font-weight:400">${(note?.status || '—').toUpperCase()}</b><br>
        ПРАВКА&nbsp;<b style="color:var(--text);font-weight:400">${fmtAge(note?.meta.h).toUpperCase()}</b>
        · ${fmtBytes(note?.meta.b || 0)} · ${note?.meta.c || 0} ${plural(note?.meta.c || 0, 'КОММИТ', 'КОММИТА', 'КОММИТОВ')}
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:10px" id="n-tags">
        ${(note?.tags || []).map(t => `<button class="chip on" data-tag="${escA(t)}" title="фильтр по тегу · Alt+клик снять">#${t}</button>`).join('')}
        <button class="chip" data-addtag title="добавить тег">＋ ТЕГ</button>
        <button class="chip" data-ai title="предложить теги и связи — применяется только по кнопке">✦ РАЗМЕТИТЬ ИИ</button>
      </div>
    </div></div>

    <div class="panel"><div class="hd">СВЯЗИ · ${note?.links.length || 0}</div>
      ${[...out].map(([type, items]) => `<div class="rail-group"><span class="lbl">${typeLabel(type)}</span><div class="rail-rows">${linkRows(items, 'out')}</div></div>`).join('')
        || '<div class="rail-rows"><div style="cursor:default;color:var(--dim);font-size:10px">ни на что не ссылается</div></div>'}
      <div style="padding:8px 12px"><button class="btn-line" data-addlink style="width:100%">＋ СВЯЗЬ</button></div>
    </div>

    <div class="panel"><div class="hd">НА ЭТО ССЫЛАЮТСЯ · ${backs.length}</div>
      ${[...back].map(([type, items]) => `<div class="rail-group"><span class="lbl">${typeLabel(type)}</span><div class="rail-rows">${linkRows(items, 'in')}</div></div>`).join('')
        || '<div class="rail-rows"><div style="cursor:default;color:var(--dim);font-size:10px">пока никто не ссылается</div></div>'}
    </div>

    ${note?.broken?.length ? `<div class="panel"><div class="hd" style="color:var(--red)">БИТЫЕ ССЫЛКИ · ${note.broken.length}</div><div class="rail-rows">${
      note.broken.map(b => `<div data-broken="${escA(b)}" title="создать эту заметку"><span class="nm">${escA(b)}</span><span class="zn">СОЗДАТЬ</span></div>`).join('')}</div></div>` : ''}

    ${claimsPanel(note)}

    <div class="panel" id="n-similar"><div class="hd">ПОХОЖИЕ</div><div class="rail-rows"><div style="cursor:default;color:var(--dim);font-size:10px">ищу…</div></div></div>

    <div class="panel"><div class="hd">ИСТОРИЯ</div><div class="rail-rows" id="n-hist">
      <div style="cursor:default"><span class="nm" data-hist style="color:var(--amber-l)">показать правки</span></div></div></div>

    <div class="panel"><div class="hd">ОГЛАВЛЕНИЕ</div><div class="toc">${sections.filter(s => s.heading).map(s => `<div data-h="h-${sections.indexOf(s)}">${'#'.repeat(s.level)} ${s.heading}</div>`).join('') || '<div style="cursor:default">без заголовков</div>'}</div></div>`;

  // Похожие — это ответ на «а где я про это уже писал». Связи показывают то, что
  // я сам когда-то связал; похожие — то, что связано по существу, но руки не
  // дошли. Считается по редким общим словам, поэтому находит и ненамеренное.
  if (note) similarTo(note, 7).then(sim => {
    const box = $('#n-similar', rail);
    if (!box) return;
    box.innerHTML = `<div class="hd">ПОХОЖИЕ · ${sim.length}</div><div class="rail-rows">${
      sim.map(({ note: o, score }) => `<div data-p="${escA(o.path)}" title="близость ${score}">${zoneDot(o.zoneRef)}<span class="nm">${o.title}</span><span class="zn">${zn(o)}</span></div>`).join('')
      || '<div style="cursor:default;color:var(--dim);font-size:10px">ничего похожего не нашлось</div>'}</div>${
      sim.length ? '<div style="padding:6px 12px"><button class="btn-line" data-linksim style="width:100%">СВЯЗАТЬ С ПЕРВОЙ</button></div>' : ''}`;
    box.querySelectorAll('[data-p]').forEach(r => r.addEventListener('click', () => { location.hash = `#/note/${encodeURIComponent(r.dataset.p)}`; }));
    $('[data-linksim]', box)?.addEventListener('click', async () => {
      try { await linkTo(path, 'relates', sim[0].note.title); toast(`СВЯЗАНО С «${sim[0].note.title}»`); reload(); }
      catch (err) { toast(`НЕ ВЫШЛО: ${err.message}`, 'err'); }
    });
  }).catch(() => { const box = $('#n-similar', rail); if (box) box.remove(); });

  rail.querySelectorAll('[data-p]').forEach(r => r.addEventListener('click', e => {
    if (e.target.dataset.unlink) return;
    location.hash = `#/note/${encodeURIComponent(r.dataset.p)}`;
  }));
  rail.querySelectorAll('[data-unlink]').forEach(x => x.addEventListener('click', async e => {
    e.stopPropagation();
    const [type, title] = x.dataset.unlink.split('|');
    try { await unlinkFrom(path, FIELD_OF_TYPE[type] || type, title); toast('СВЯЗЬ УБРАНА'); reload(); }
    catch (err) { toast(`НЕ ВЫШЛО: ${err.message}`, 'err'); }
  }));
  rail.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', async e => {
    const tag = b.dataset.tag;
    if (e.altKey) {
      try { await toggleTag(path, tag, false); toast(`СНЯТ ТЕГ #${tag}`); reload(); }
      catch (err) { toast(`НЕ ВЫШЛО: ${err.message}`, 'err'); }
      return;
    }
    location.hash = `#/cards?tag=${encodeURIComponent(tag)}`;
  }));
  $('[data-addtag]', rail)?.addEventListener('click', () => askTag(path, reload));
  $('[data-ai]', rail)?.addEventListener('click', () => aiMarkup(note, path, reload));
  $('[data-addlink]', rail)?.addEventListener('click', () => askLink(path, reload));
  /* История. Загружается по требованию: у большинства заметок её открывают
     редко, а каждый вызов — это поход в GitHub за списком коммитов. Дальше
     выбранная версия сравнивается с текущей построчно (тот же дифф, что
     показывается при конфликте записи), и её можно вернуть целиком. */
  $('[data-hist]', rail)?.addEventListener('click', async () => {
    const box = $('#n-hist', rail);
    box.innerHTML = '<div style="cursor:default;color:var(--dim);font-size:10px">читаю git…</div>';
    let lines;
    try { lines = (await tools.history(path, 20)).split('\n').filter(Boolean); }
    catch (e) {
      box.innerHTML = `<div style="cursor:default;color:var(--dim);font-size:10px">${
        /неизвестн/i.test(e.message) ? 'воркер ещё без vault_history — нужен деплой' : escA(e.message)}</div>`;
      return;
    }
    const commits = lines.map(l => {
      const m = l.match(/^([0-9a-f]{6,})\s+(\S+ \S+)\s+(.*)$/);
      return m ? { sha: m[1], when: m[2], msg: m[3] } : null;
    }).filter(Boolean);
    if (!commits.length) { box.innerHTML = `<div style="cursor:default;color:var(--dim);font-size:10px">${escA(lines[0] || 'истории нет')}</div>`; return; }
    box.innerHTML = commits.map((c, i) => `<div data-sha="${escA(c.sha)}" title="${escA(c.msg)}">
      <span class="nm">${escA(c.msg.slice(0, 46))}</span><span class="zn">${escA(c.when.slice(5, 16))}${i ? '' : ' · СЕЙЧАС'}</span></div>`).join('');
    box.querySelectorAll('[data-sha]').forEach(r => r.addEventListener('click', () => showVersion(path, r.dataset.sha, commits.find(c => c.sha === r.dataset.sha), reload)));
  });

  rail.querySelectorAll('[data-broken]').forEach(b => b.addEventListener('click', () => {
    toast(`СОЗДАЙТЕ ЗАМЕТКУ «${b.dataset.broken}» — [C]`, 'warn', 5000);
  }));
  rail.querySelectorAll('[data-h]').forEach(r => r.addEventListener('click', () => {
    const t = document.getElementById(r.dataset.h);
    if (t) $('.note-wrap', root).scrollTo({ top: t.getBoundingClientRect().top + $('.note-wrap', root).scrollTop - 80, behavior: 'smooth' });
  }));
}

// Ввод тега с подсказкой по уже существующим: главный способ не расплодить
// «ереван», «Ереван» и «ереван/переезд» как три разных тега.
function askTag(path, reload) {
  const wrap = $('#modal');
  const all = [...corpus.tagCounts].slice(0, 40);
  wrap.innerHTML = `<div class="cap"><div class="hd">ДОБАВИТЬ ТЕГ<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="row"><label><span class="lbl">ТЕГ (МОЖНО ИЕРАРХИЮ ЧЕРЕЗ /)</span><input id="tg-in" placeholder="проект/ереван" spellcheck="false" list="tg-list">
      <datalist id="tg-list">${all.map(([t]) => `<option value="${escA(t)}">`).join('')}</datalist></label></div>
    <div class="hint-row">${all.length ? 'ЧАСТЫЕ: ' + all.slice(0, 10).map(([t, n]) => `<span class="chip" data-pick="${escA(t)}" style="cursor:pointer">#${t} ${n}</span>`).join(' ') : 'в вальте пока нет тегов'}</div>
    <div class="ft"><button class="btn-amber" style="margin:0" id="tg-ok">ДОБАВИТЬ [ENTER]</button><button class="btn-line" id="tg-no">ОТМЕНА</button></div></div>`;
  wrap.classList.add('open');
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  const input = $('#tg-in', wrap);
  setTimeout(() => input.focus(), 30);
  const save = async () => {
    const tag = input.value.trim();
    if (!tag) return close();
    close();
    try { await toggleTag(path, tag, true); toast(`ТЕГ #${tag} ДОБАВЛЕН`); reload(); }
    catch (e) { toast(`НЕ ВЫШЛО: ${e.message}`, 'err'); }
  };
  wrap.querySelectorAll('[data-pick]').forEach(c => c.addEventListener('click', () => { input.value = c.dataset.pick; save(); }));
  $('#tg-ok', wrap).addEventListener('click', save);
  $('#tg-no', wrap).addEventListener('click', close);
  wrap.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
}

// Типизированная связь: сначала «чем связаны», потом «с чем». Порядок важен —
// тип определяет смысл, а обычную ссылку и так можно поставить прямо в тексте.
function askLink(path, reload) {
  const wrap = $('#modal');
  wrap.innerHTML = `<div class="cap"><div class="hd">СВЯЗАТЬ ЗАМЕТКУ<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="row"><label><span class="lbl">ЧЕМ СВЯЗАНЫ</span><select id="lk-type">
      ${LINK_TYPES.map(t => `<option value="${t.key}">${t.label} — ${t.hint}</option>`).join('')}</select></label></div>
    <div class="row"><label><span class="lbl">С ЧЕМ</span><input id="lk-target" placeholder="начните вводить название…" spellcheck="false" autocomplete="off"></label></div>
    <div class="ask-ctx" id="lk-found" style="max-height:220px;overflow:auto;margin:0 14px"></div>
    <div class="ft"><button class="btn-line" id="lk-no">ОТМЕНА</button><span class="note">связь пишется во фронтматтер — Obsidian и Dataview её видят</span></div></div>`;
  wrap.classList.add('open');
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  const input = $('#lk-target', wrap), found = $('#lk-found', wrap);
  setTimeout(() => input.focus(), 30);
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const list = corpus.notes
      .filter(n => n.path !== path && (!q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)))
      .slice(0, 12);
    found.innerHTML = list.map(n => `<div class="result" data-t="${escA(n.title)}"><div class="path">${zoneDot(n.zoneRef)}<span style="color:var(--text)">${n.title}</span><span style="color:#454c60;margin-left:auto">${zn(n)}</span></div></div>`).join('')
      || '<div style="color:var(--dim);font-size:10px;padding:8px 0">ничего не нашлось</div>';
    found.querySelectorAll('[data-t]').forEach(r => r.addEventListener('click', async () => {
      const field = $('#lk-type', wrap).value;
      close();
      try { await linkTo(path, field, r.dataset.t); toast(`СВЯЗЬ ПОСТАВЛЕНА: ${field.toUpperCase()} → ${r.dataset.t.toUpperCase()}`); reload(); }
      catch (e) { toast(`НЕ ВЫШЛО: ${e.message}`, 'err'); }
    }));
  };
  input.addEventListener('input', draw);
  draw();
  $('#lk-no', wrap).addEventListener('click', close);
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
}

// Дифф в конфликте: показываем, чем серверная версия раздела отличается от той,
// что человек правит. Без этого «перечитать и повторить» означает либо затереть
// чужую правку, либо потерять свою.
const diffHtml = parts => `<div class="diff">${parts.map(p =>
  `<div class="dl ${p.type}">${p.text.split('\n').map(l => `<span>${(p.type === 'add' ? '+ ' : p.type === 'del' ? '− ' : p.type === 'skip' ? '' : '  ') + l}</span>`).join('')}</div>`).join('')}</div>`;

const OPS = [
  { op: 'replace', label: 'ЗАМЕНИТЬ', note: 'заголовок останется · тело заменится' },
  { op: 'append', label: 'В КОНЕЦ', note: 'текст добавится в конец раздела' },
  { op: 'prepend', label: 'СВЕРХУ', note: 'текст встанет сразу под заголовок — так пишутся логи' },
];

function editSection(sectEl, path, s, reload) {
  if (sectEl.querySelector('.editor')) return;
  const mdDiv = $('.md', sectEl);
  mdDiv.style.display = 'none';
  let op = 'replace';
  const ed = el('div', 'editor');
  ed.innerHTML = `<div class="ehd">ПРАВКА РАЗДЕЛА <span style="color:var(--bright);font-family:var(--ui);font-size:13px;font-weight:600">${s.heading}</span>
    <span class="seg" style="margin-left:auto">${OPS.map(o => `<button class="chip ${o.op === 'replace' ? 'on' : ''}" data-op="${o.op}">${o.label}</button>`).join('')}</span></div>
    <textarea spellcheck="false">${s.body.trim().replace(/</g, '&lt;')}</textarea>
    <div class="conflict" hidden></div>
    <div class="eft"><button class="btn-amber" style="margin:0">СОХРАНИТЬ [CTRL+ENTER]</button><button class="btn-line">ОТМЕНА [ESC]</button>
    <span class="note" style="margin-left:auto;font-size:9.5px;color:var(--dim)">${OPS[0].note}</span></div>`;
  sectEl.appendChild(ed);
  const ta = $('textarea', ed), conf = $('.conflict', ed), note = $('.note', ed);
  ta.focus();
  const close = () => { ed.remove(); mdDiv.style.display = ''; document.activeElement?.blur(); };

  // Правим по свежему тексту раздела, а не по копии из индекса: vault_section
  // тянет один раздел вместо файла целиком — в вальте есть заметки по 45 КБ,
  // и качать их ради одного абзаца незачем.
  if (s.heading) {
    tools.section(path, s.heading).then(text => {
      const body = text.replace(/^#{1,6} .*\n?/, '').replace(/\n+— раздел «[\s\S]*$/, '').trim();
      if (body && body !== ta.value.trim() && ta.value.trim() === s.body.trim()) {
        ta.value = body;
        s.body = body;
      }
    }).catch(() => {});   // нет сети — правим то, что есть
  }

  // при смене операции меняется смысл поля: заменяем тело или дописываем кусок
  ed.querySelectorAll('[data-op]').forEach(b => b.addEventListener('click', () => {
    const next = b.dataset.op;
    if (next === op) return;
    const wasUntouched = op === 'replace' ? ta.value.trim() === s.body.trim() : !ta.value.trim();
    ed.querySelectorAll('[data-op]').forEach(x => x.classList.toggle('on', x === b));
    op = next;
    note.textContent = OPS.find(o => o.op === op).note;
    if (wasUntouched) ta.value = op === 'replace' ? s.body.trim() : '';
    ta.placeholder = op === 'replace' ? '' : 'что дописать в раздел…';
    ta.focus();
  }));

  async function save() {
    const btn = $('.btn-amber', ed);
    if (!ta.value.trim() && op !== 'replace') return toast('ПУСТО — НЕЧЕГО ДОПИСЫВАТЬ', 'warn');
    btn.textContent = 'СОХРАНЯЮ…';
    try {
      const answer = await patchSection(path, s.heading, ta.value, op);
      toast(answer.toUpperCase().slice(0, 70));
      reload();
    } catch (e) {
      btn.textContent = 'СОХРАНИТЬ [CTRL+ENTER]';
      conf.hidden = false;
      if (isConflict(e)) {
        conf.innerHTML = `КОНФЛИКТ: файл изменён с другого устройства.<br>${e.message}
          <div style="margin-top:8px;display:flex;gap:8px"><button class="btn-line" data-act="show">ПОКАЗАТЬ РАЗЛИЧИЯ</button>
          <button class="btn-line" data-act="retry">ПОВТОРИТЬ ПОВЕРХ СВЕЖЕЙ</button></div><div data-slot></div>`;
        const slot = $('[data-slot]', conf);
        const freshSection = async () => {
          const fresh = await tools.read(path);
          return parseSections(splitFrontmatter(fresh).body).find(x => x.heading === s.heading);
        };
        $('[data-act="show"]', conf).addEventListener('click', async () => {
          const ns = await freshSection();
          if (!ns) { slot.innerHTML = '<div style="margin-top:8px">Раздел исчез из свежей версии файла — откройте заметку заново.</div>'; return; }
          const parts = collapseSame(diffLines(ns.body.trim(), ta.value.trim()));
          slot.innerHTML = `<div style="margin-top:10px;font-size:9.5px;color:var(--dim)">− НА СЕРВЕРЕ · + ВАША ПРАВКА</div>${diffHtml(parts)}`;
        });
        $('[data-act="retry"]', conf).addEventListener('click', async () => {
          const ns = await freshSection();
          if (ns && op === 'replace') {
            slot.innerHTML = `<div style="margin-top:8px">Свежая версия раздела подставлена ниже — внесите правку заново и сохраните.</div>`;
            ta.value = ns.body.trim();
          } else { conf.hidden = true; save(); }
        });
      } else conf.textContent = `ОШИБКА: ${e.message}`;
    }
  }
  $('.btn-amber', ed).addEventListener('click', save);
  $('.btn-line', ed).addEventListener('click', close);
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
}

// Новый раздел: vault_patch умеет писать только под существующий заголовок,
// поэтому раздел дописывается в конец файла через vault_append.
function newSection(root, path, reload) {
  const box = el('div', 'editor');
  box.innerHTML = `<div class="ehd">НОВЫЙ РАЗДЕЛ<span style="margin-left:auto;color:var(--dim)">APPEND · В КОНЕЦ ФАЙЛА</span></div>
    <div class="row" style="padding:12px 12px 0"><label style="flex:1"><span class="lbl">ЗАГОЛОВОК</span><input data-h placeholder="Название раздела" spellcheck="false"></label></div>
    <textarea data-b spellcheck="false" placeholder="текст раздела…"></textarea>
    <div class="eft"><button class="btn-amber" style="margin:0">ДОБАВИТЬ [CTRL+ENTER]</button><button class="btn-line">ОТМЕНА [ESC]</button></div>`;
  root.appendChild(box);
  const h = $('[data-h]', box), b = $('[data-b]', box);
  h.focus();
  const close = () => box.remove();
  async function save() {
    const heading = h.value.trim();
    if (!heading) return toast('НУЖЕН ЗАГОЛОВОК РАЗДЕЛА', 'warn');
    const btn = $('.btn-amber', box); btn.textContent = 'ДОБАВЛЯЮ…';
    try { toast((await addSection(path, heading, b.value)).toUpperCase().slice(0, 70)); reload(); }
    catch (e) { btn.textContent = 'ДОБАВИТЬ [CTRL+ENTER]'; toast(`НЕ ДОБАВИЛОСЬ: ${e.message}`, 'err'); }
  }
  $('.btn-amber', box).addEventListener('click', save);
  $('.btn-line', box).addEventListener('click', close);
  box.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
}

/* ── картотека ───────────────────────────────────────────── */
const cardState = { sort: 'fresh', view: 'table', q: '', tag: '', sel: new Set(), anchor: null };
export function renderCards(root, tag) {
  cardState.tag = tag || '';
  root.innerHTML = `<div class="cards-wrap">
    <div class="toolbar">
      <span class="lbl">СОРТ</span>
      <span style="display:flex;gap:6px">
        <button class="chip" data-s="fresh">СВЕЖЕСТЬ ↓</button><button class="chip" data-s="size">РАЗМЕР</button>
        <button class="chip" data-s="deg">СВЯЗНОСТЬ</button><button class="chip" data-s="name">ИМЯ</button></span>
      <span class="lbl" style="margin-left:8px">ВИД</span>
      <span class="seg"><button class="chip" data-v="table">ТАБЛИЦА</button><button class="chip" data-v="grid">СЕТКА</button></span>
      <span style="display:flex;gap:5px;flex-wrap:wrap" id="k-zones"></span>
      <span class="sp"></span>
      ${cardState.tag ? `<button class="chip on" id="k-tag" title="снять фильтр по тегу">#${escA(cardState.tag)} ✕</button>` : ''}
      <button class="chip" id="k-tags-all" title="все теги вальта">ТЕГИ ${corpus.tagCounts.size}</button>
      <input id="k-q" placeholder="фильтр…" spellcheck="false" value="${escA(cardState.q)}">
    </div>
    <div class="masspanel" id="k-mass" hidden></div>
    <div class="cards-body" id="k-body"></div></div>`;

  const zbox = $('#k-zones', root);
  const drawZones = () => {
    zbox.innerHTML = corpus.zones.map((z, i) => `<button class="chip ${z.on ? 'on' : ''}" data-z="${i}" title="${escA(z.name)}" style="display:flex;align-items:center;gap:6px">${zoneDot(z)}${z.label}</button>`).join('');
    zbox.querySelectorAll('[data-z]').forEach(b => b.addEventListener('click', () => { const z = corpus.zones[+b.dataset.z]; z.on = !z.on; drawZones(); draw(); }));
  };
  const mark = () => {
    root.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === cardState.sort));
    root.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === cardState.view));
  };
  function rows() {
    const q = cardState.q.toLowerCase();
    // Тег включает и вложенные: фильтр «проект» показывает «проект/ереван».
    const tag = cardState.tag;
    let list = corpus.notes.filter(n => isVisible(n)
      && (!tag || (n.tags || []).some(t => t === tag || t.startsWith(tag + '/')))
      && (!q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q) || (n.tags || []).some(t => t.includes(q))));
    const by = {
      fresh: (a, b) => new Date(b.meta.h || 0) - new Date(a.meta.h || 0),
      size: (a, b) => b.meta.b - a.meta.b,
      deg: (a, b) => b.deg - a.deg,
      name: (a, b) => a.title.localeCompare(b.title, 'ru'),
    };
    return list.sort(by[cardState.sort]);
  }
  // Разметка одной строки таблицы вынесена: её рисует и обычный проход,
  // и виртуализация.
  const rowHtml = n => `<div class="trow${cardState.sel.has(n.path) ? ' picked' : ''}" data-p="${escA(n.path)}"><span class="nm">${n.title}</span>
    <span class="zone-tag" style="color:${n.zoneRef.color}" title="${escA(n.zone)}">■ ${zn(n)}</span>
    <span>${fmtAge(n.meta.h).toUpperCase()}</span><span>${fmtBytes(n.meta.b)}</span><span>${n.deg}</span><span>${n.meta.c}</span></div>`;
  const HEAD = `<div class="trow head"><span>ИМЯ</span><span>ЗОНА</span><span>ПРАВКА</span><span>РАЗМЕР</span><span>СВЯЗИ</span><span>КОММИТЫ</span></div>`;

  /* Виртуализация включается только на длинных списках. Вальт растёт, и на
     нескольких тысячах строк браузер начинает заикаться на каждом фильтре;
     на нынешних двух сотнях полная отрисовка проще и ведёт себя предсказуемее
     (поиск по странице, прокрутка к элементу), поэтому порог, а не всегда. */
  const VIRT_FROM = 400, ROW_H = 38, OVERSCAN = 10;
  function drawVirtual(list, body) {
    body.innerHTML = `${HEAD}<div class="virt" style="position:relative"><div class="virt-pad" style="height:${list.length * ROW_H}px"></div><div class="virt-win" style="position:absolute;left:0;right:0;top:0"></div></div>`;
    const win = $('.virt-win', body);
    let from = -1;
    const paint = () => {
      const start = Math.max(0, Math.floor(body.scrollTop / ROW_H) - OVERSCAN);
      if (start === from) return;
      from = start;
      const count = Math.ceil(body.clientHeight / ROW_H) + OVERSCAN * 2;
      const slice = list.slice(start, start + count);
      win.style.transform = `translateY(${start * ROW_H}px)`;
      win.innerHTML = slice.map(rowHtml).join('');
      wireRows(win, list);
    };
    body.onscroll = paint;
    paint();
  }

  function draw() {
    mark();
    const list = rows(); const body = $('#k-body', root);
    body.onscroll = null;
    if (cardState.view === 'table' && list.length >= VIRT_FROM) {
      drawVirtual(list, body);
      $('.strip .info#top-count') && ($('.strip .info#top-count').textContent = `${corpus.notes.length} ЗАМЕТОК · ПОКАЗАНО ${list.length}`);
      return;
    }
    if (cardState.view === 'table') {
      body.innerHTML = HEAD + list.map(rowHtml).join('');
    } else {
      body.innerHTML = `<div class="grid-cards">` + list.map(n => `<div class="gcard" data-p="${escA(n.path)}">
        <span class="zone-tag" style="color:${n.zoneRef.color};font-size:9px" title="${escA(n.zone)}">■ ${zn(n)}</span>
        <div class="nm">${n.title}</div><div class="mt">правка ${fmtAge(n.meta.h)} · ${fmtBytes(n.meta.b)}<br>${n.deg} ${plural(n.deg, 'связь', 'связи', 'связей')} · ${n.meta.c} ${plural(n.meta.c, 'коммит', 'коммита', 'коммитов')}</div></div>`).join('') + '</div>';
    }
    wireRows(body, list);
    $('.strip .info#top-count') && ($('.strip .info#top-count').textContent = `${corpus.notes.length} ЗАМЕТОК · ПОКАЗАНО ${list.length}`);
  }

  /* Выделение. Обычный клик открывает заметку — так было и так остаётся, иначе
     картотека перестанет быть картотекой ради редкой операции. Ctrl добавляет
     в набор, Shift берёт всё от прошлой отметки до текущей: так же, как в любом
     файловом менеджере, где эту механику уже знают руки. */
  const paintSel = () => {
    root.querySelectorAll('[data-p]').forEach(r => r.classList.toggle('picked', cardState.sel.has(r.dataset.p)));
    drawMass();
  };
  function wireRows(box, list) {
    box.querySelectorAll('[data-p]').forEach(r => r.addEventListener('click', e => {
      const p = r.dataset.p;
      if (e.ctrlKey || e.metaKey) {
        cardState.sel.has(p) ? cardState.sel.delete(p) : cardState.sel.add(p);
        cardState.anchor = p; paintSel(); return;
      }
      if (e.shiftKey && cardState.anchor) {
        const paths = list.map(n => n.path);
        const a = paths.indexOf(cardState.anchor), b = paths.indexOf(p);
        if (a >= 0 && b >= 0) { for (let i = Math.min(a, b); i <= Math.max(a, b); i++) cardState.sel.add(paths[i]); }
        paintSel(); return;
      }
      location.hash = `#/note/${encodeURIComponent(p)}`;
    }));
  }
  function drawMass() {
    const box = $('#k-mass', root), n = cardState.sel.size;
    box.hidden = !n;
    if (!n) return;
    box.innerHTML = `<b>ВЫБРАНО ${n}</b>
      <button class="chip" data-m="tag">＋ ТЕГ</button>
      <button class="chip" data-m="untag">− ТЕГ</button>
      <button class="chip" data-m="link">СВЯЗАТЬ С…</button>
      <button class="chip" data-m="field">ПОЛЕ…</button>
      <button class="chip" data-m="copy">СКОПИРОВАТЬ СПИСОК</button>
      <button class="chip" data-m="ask">СПРОСИТЬ ПО НИМ</button>
      <span class="sp"></span>
      <button class="chip" data-m="all">ВЫБРАТЬ ВСЁ ПОКАЗАННОЕ</button>
      <button class="chip" data-m="none">СНЯТЬ ВЫДЕЛЕНИЕ</button>`;
    const picked = () => [...cardState.sel];
    box.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
      const m = b.dataset.m;
      if (m === 'none') { cardState.sel.clear(); paintSel(); return; }
      if (m === 'all') { rows().forEach(x => cardState.sel.add(x.path)); paintSel(); return; }
      if (m === 'copy') {
        const text = picked().map(p => `- [[${corpus.byPath.get(p)?.title || p.replace(/\.md$/, '')}]]`).join('\n');
        navigator.clipboard.writeText(text).then(() => toast(`СКОПИРОВАНО ${cardState.sel.size} ССЫЛОК — ВСТАВЬТЕ В ЛЮБУЮ ЗАМЕТКУ`),
          () => toast('БУФЕР НЕДОСТУПЕН', 'err'));
        return;
      }
      if (m === 'ask') {
        location.hash = `#/ask?q=${encodeURIComponent(picked().map(p => corpus.byPath.get(p)?.title || p).join(', ') + ' — что общего и что из этого следует?')}`;
        return;
      }
      massOp(m, picked(), () => { cardState.sel.clear(); paintSel(); draw(); });
    }));
  }
  root.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { cardState.sort = b.dataset.s; draw(); }));
  root.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { cardState.view = b.dataset.v; draw(); }));
  $('#k-tag', root)?.addEventListener('click', () => { location.hash = '#/cards'; });
  $('#k-tags-all', root)?.addEventListener('click', () => showAllTags());
  $('#k-q', root).addEventListener('input', e => { cardState.q = e.target.value; draw(); });
  drawZones(); draw();
}

/* Настройки смыслового слоя. Он выключен по умолчанию и включается только
   осознанно: для работы нужны и собранные векторы в вальте, и эндпоинт, который
   посчитает вектор запроса. Здесь же видно, чего не хватает, — иначе включённый
   тумблер без векторов выглядел бы как поломка поиска. */
async function embedSettings(onDone) {
  const wrap = $('#modal');
  const s = getEmbedSettings();
  const ready = await initVectors().catch(() => false);
  const m = vecState.manifest;
  wrap.innerHTML = `<div class="cap" style="width:640px"><div class="hd">СМЫСЛОВОЙ ПОИСК<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="hint-row">поиск по словам находит названное своим именем; смысловой — то, что вспоминается описанием. Работают вместе: результат тем выше, чем выше он в обоих списках.</div>
    <div class="row"><label style="flex:1"><span class="lbl">ЭНДПОИНТ ЭМБЕДДИНГОВ</span>
      <input id="ev-url" value="${escA(s.url)}" spellcheck="false"></label></div>
    <div class="row" style="padding-top:0"><label style="flex:1"><span class="lbl">МОДЕЛЬ</span>
      <input id="ev-model" value="${escA(s.model)}" spellcheck="false"></label></div>
    <div class="search-stats" style="padding:0 14px">${ready
      ? `<span style="color:var(--green)">векторы в вальте: ${m.count} ${plural(m.count, 'кусок', 'куска', 'кусков')}, ${m.dim} измерений, модель ${escA(m.model)}, собраны ${String(m.built).slice(0, 10)}</span>`
      : `<span style="color:var(--amber-l)">векторов в вальте нет${vecState.error ? ` (${escA(vecState.error)})` : ''} — соберите: node build-vectors.mjs</span>`}</div>
    <div class="ft">
      <button class="btn-amber" style="margin:0" id="ev-on" ${ready ? '' : 'disabled'}>${s.on ? 'ВЫКЛЮЧИТЬ' : 'ВКЛЮЧИТЬ'}</button>
      <button class="btn-line" id="ev-test">ПРОВЕРИТЬ ЭНДПОИНТ</button>
      <button class="btn-line" id="ev-close">ЗАКРЫТЬ</button>
      <span class="note">адрес и модель хранятся только на этом устройстве</span></div></div>`;
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); onDone?.(); };
  const grab = () => saveEmbedSettings({ url: $('#ev-url', wrap).value.trim(), model: $('#ev-model', wrap).value.trim() });
  $('#ev-close', wrap).addEventListener('click', close);
  $('#ev-on', wrap).addEventListener('click', () => {
    grab();
    const now = !getEmbedSettings().on;
    saveEmbedSettings({ on: now });
    toast(now ? 'СМЫСЛОВОЙ СЛОЙ ВКЛЮЧЁН' : 'СМЫСЛОВОЙ СЛОЙ ВЫКЛЮЧЕН');
    close();
  });
  $('#ev-test', wrap).addEventListener('click', async () => {
    grab();
    const btn = $('#ev-test', wrap); btn.textContent = 'ПРОВЕРЯЮ…';
    try {
      const was = getEmbedSettings().on;
      saveEmbedSettings({ on: true });
      const v = await embedQuery('проверка связи');
      saveEmbedSettings({ on: was });
      toast(`ЭНДПОИНТ ОТВЕТИЛ: ${v.length} ИЗМЕРЕНИЙ${m && v.length !== m.dim ? ` · НО В ВАЛЬТЕ ${m.dim} — МОДЕЛИ РАЗНЫЕ` : ''}`, m && v.length !== m.dim ? 'warn' : '', 6000);
    } catch (e) { toast(`НЕ ОТВЕТИЛ: ${e.message}`, 'err', 6000); }
    btn.textContent = 'ПРОВЕРИТЬ ЭНДПОИНТ';
  });
  wrap.classList.add('open');
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
}

/* ── ИИ-помощники ────────────────────────────────────────────────────────────
   Общая обвязка для всех помощников. Она устроена так, что ключ Anthropic —
   удобство, а не условие: с ключом запрос уходит прямо отсюда и ответ печатается
   на месте, без ключа тот же самый текст копируется в буфер, человек относит его
   в любой чат и вставляет ответ обратно — разбор и применение одинаковые.

   Ничего не пишется в вальт само: помощник только предлагает, применяет человек. */
async function runHelper(h, render) {
  const wrap = $('#modal');
  const hasKey = !!getAiSettings().key;
  wrap.innerHTML = `<div class="cap" style="width:760px"><div class="hd">${escA(h.title)}<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="hint-row">${hasKey ? `модель ${MODEL} · ответ ниже, применяется только по кнопке` : 'ключа нет — запрос уйдёт в буфер, ответ вставьте обратно'}</div>
    <div class="ask-ctx" id="hp-out" style="max-height:46vh;overflow:auto;margin:10px 14px;white-space:pre-wrap;font:400 12px/1.6 var(--ui);color:var(--text)"></div>
    <div id="hp-paste" ${hasKey ? 'hidden' : ''} style="padding:0 14px">
      <textarea id="hp-in" spellcheck="false" placeholder="вставьте сюда ответ модели" style="width:100%;height:110px"></textarea></div>
    <div class="ft">
      ${hasKey ? '<button class="btn-amber" style="margin:0" id="hp-run">СПРОСИТЬ</button>' : '<button class="btn-amber" style="margin:0" id="hp-parse">РАЗОБРАТЬ ОТВЕТ</button>'}
      <button class="btn-line" id="hp-copy">СКОПИРОВАТЬ ЗАПРОС</button>
      <button class="btn-line" id="hp-close">ЗАКРЫТЬ</button></div></div>`;
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  const out = $('#hp-out', wrap);
  $('#hp-close', wrap).addEventListener('click', close);
  $('#hp-copy', wrap).addEventListener('click', () => navigator.clipboard.writeText(packHelper(h))
    .then(() => toast('ЗАПРОС В БУФЕРЕ — ВСТАВЬТЕ В ЛЮБОЙ ЧАТ')).catch(() => toast('БУФЕР НЕДОСТУПЕН', 'err')));
  wrap.classList.add('open');
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  const finish = text => { try { render(h.parse(text), out, close); } catch (e) { toast(`ОТВЕТ НЕ РАЗОБРАН: ${e.message}`, 'err'); } };
  const ask = async () => {
    const btn = $('#hp-run', wrap); btn.disabled = true; btn.textContent = 'ДУМАЮ…';
    out.textContent = '';
    try {
      const { text } = await callClaude(h.system, h.user, { mode: 'fast', onText: (_, all) => { out.textContent = all ?? out.textContent; } });
      finish(text);
    } catch (e) { out.innerHTML = `<div class="conflict">${escA(e.message)}</div>`; }
    btn.disabled = false; btn.textContent = 'СПРОСИТЬ ЕЩЁ';
  };
  if (hasKey) { $('#hp-run', wrap).addEventListener('click', ask); ask(); }
  else {
    navigator.clipboard.writeText(packHelper(h)).then(() => toast('ЗАПРОС В БУФЕРЕ')).catch(() => {});
    $('#hp-parse', wrap).addEventListener('click', () => {
      const v = $('#hp-in', wrap).value.trim();
      if (!v) return toast('ВСТАВЬТЕ ОТВЕТ МОДЕЛИ', 'warn');
      out.textContent = v; finish(v);
    });
  }
}

// Разметка одной заметки: теги из уже существующего словаря вальта и связи с
// похожими. Всё приходит галочками — ставится только отмеченное.
async function aiMarkup(note, path, reload) {
  const text = await textOf(note || path).catch(() => '');
  const neighbours = (await similarTo(note, 8).catch(() => [])).map(s => s.note);
  const h = HELPERS.markup({ note, text: splitFrontmatter(text).body, tags: [...corpus.tagCounts], neighbours });
  runHelper(h, (res, out, close) => {
    // Отмеченное — это ровно то, что горит: набор живёт в разметке, а не в
    // отдельном множестве, которое пришлось бы держать с ней в согласии.
    out.innerHTML = `<div style="font-size:10px;color:var(--dim);letter-spacing:.14em;margin-bottom:6px">ТЕГИ</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">${res.tags.map(t => `<button class="chip on" data-x="tag:${escA(t)}">#${escA(t)}</button>`).join('') || '<span style="font-size:10px;color:var(--dim)">не предложено</span>'}</div>
      <div style="font-size:10px;color:var(--dim);letter-spacing:.14em;margin:12px 0 6px">СВЯЗИ</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">${res.links.map(t => `<button class="chip on" data-x="link:${escA(t)}">${escA(t)}</button>`).join('') || '<span style="font-size:10px;color:var(--dim)">не предложено</span>'}</div>
      <button class="btn-amber" id="hp-apply" style="margin:14px 0 0">ПРИМЕНИТЬ ОТМЕЧЕННОЕ</button>`;
    out.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
    $('#hp-apply', out).addEventListener('click', async () => {
      const btn = $('#hp-apply', out); btn.disabled = true; btn.textContent = 'ПИШУ…';
      const errs = [];
      for (const b of out.querySelectorAll('[data-x].on')) {
        const [kind, val] = [b.dataset.x.split(':')[0], b.dataset.x.slice(b.dataset.x.indexOf(':') + 1)];
        try { kind === 'tag' ? await toggleTag(path, val, true) : await linkTo(path, 'relates', val); }
        catch (e) { errs.push(e.message); }
      }
      toast(errs.length ? `ЧАСТИЧНО: ${errs[0]}` : 'РАЗМЕЧЕНО', errs.length ? 'warn' : '');
      close(); reload();
    });
  });
}

/* Недельная сводка: что трогали, что подвисло, что разобрать. Заметки берутся
   из корпуса по дате правки — модель получает готовый список, а не ищет сама. */
async function aiDigest(days = 7) {
  const since = Date.now() - days * 864e5;
  const notes = corpus.notes
    .filter(n => isVisible(n) && Date.parse(n.meta.h || 0) > since)
    .sort((a, b) => new Date(b.meta.h) - new Date(a.meta.h))
    .slice(0, 40);
  if (!notes.length) return toast(`ЗА ${days} ДНЕЙ НИЧЕГО НЕ МЕНЯЛОСЬ`, 'warn');
  const unsorted = corpus.notes.filter(n => isVisible(n) && !n.zoneRef?.chronicle && (!n.tags?.length || (!n.links.length && !n.backlinks?.length))).slice(0, 20);
  runHelper(HELPERS.digest({ days, notes, unsorted }), (res, out) => { out.innerHTML = renderMd(res.raw); wireWikiLinks(out); });
}

// Описание созвездия: механика собрала группу, но назвать её словами человека
// механика не может — три характерных слова это ещё не имя.
function aiCluster(cluster) {
  const notes = cluster.members.map(i => corpus.notes[i]).filter(Boolean).slice(0, 60);
  runHelper(HELPERS.cluster({ label: cluster.label, notes }), (res, out) => {
    out.innerHTML = `<div style="font:500 15px var(--ui);color:var(--amber-l);margin-bottom:6px">${escA(res.name || cluster.label)}</div>
      <div style="margin-bottom:10px">${escA(res.about || '')}</div>
      ${res.odd && !/всё на месте/i.test(res.odd) ? `<div style="font-size:11px;color:var(--red)">не на месте: ${escA(res.odd)}</div>` : ''}
      <div style="font-size:10px;color:var(--dim);margin-top:12px">${notes.length} ${plural(notes.length, 'заметка', 'заметки', 'заметок')} в созвездии</div>`;
  });
}

/* Одна версия из истории: что было тогда и чем отличается от сегодняшнего.

   Возврат делается обычной перезаписью, а не «git revert»: приложение не умеет
   и не должно уметь двигать историю репозитория — оно пишет новую версию поверх
   текущей, и в истории остаётся и то, и другое. Это единственный безопасный
   способ отката, когда над одним вальтом работают и человек, и машина. */
async function showVersion(path, sha, meta, reload) {
  const wrap = $('#modal');
  wrap.innerHTML = `<div class="cap" style="width:820px"><div class="hd">ВЕРСИЯ ${escA(sha.slice(0, 8))} · ${escA(meta?.when || '')}<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="hint-row">${escA(meta?.msg || '')}</div>
    <div class="ask-ctx" id="hv-body" style="max-height:56vh;overflow:auto;margin:10px 14px">читаю…</div>
    <div class="ft"><button class="btn-amber" style="margin:0" id="hv-restore" disabled>ВЕРНУТЬ ЭТУ ВЕРСИЮ</button>
      <button class="btn-line" id="hv-close">ЗАКРЫТЬ</button>
      <span class="note">возврат — это новая запись поверх текущей, история сохраняется целиком</span></div></div>`;
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  $('#hv-close', wrap).addEventListener('click', close);
  wrap.classList.add('open');
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });

  let old;
  try { old = await tools.at(path, sha); }
  catch (e) { $('#hv-body', wrap).innerHTML = `<div class="conflict">${escA(e.message)}</div>`; return; }
  const now = await textOf(corpus.byPath.get(path) || path).catch(() => '');
  // «−» — то, что было в той версии, «+» — то, что стоит сейчас.
  $('#hv-body', wrap).innerHTML = diffHtml(collapseSame(diffLines(old, now), 2))
    + (old === now ? '<div style="color:var(--green);font-size:10px;padding:8px 2px">эта версия совпадает с текущей</div>' : '');
  const btn = $('#hv-restore', wrap);
  btn.disabled = old === now;
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'ПИШУ…';
    try {
      await tools.write(path, old, `откат к ${sha.slice(0, 8)} из «Осколков»`);
      forgetText(path);
      toast(`ВЕРНУЛ ВЕРСИЮ ${sha.slice(0, 8).toUpperCase()}`);
      close(); reload();
    } catch (e) { btn.disabled = false; btn.textContent = 'ВЕРНУТЬ ЭТУ ВЕРСИЮ'; toast(`НЕ ВЫШЛО: ${e.message}`, 'err'); }
  });
}

/* Массовая операция над выбранными заметками.

   Пишем строго по одной и последовательно: воркер ходит в GitHub Contents API,
   а тот на параллельных записях в один репозиторий отвечает конфликтами. Живая
   строка прогресса нужна не для красоты — на полусотне файлов это полминуты, и
   человек должен видеть, что происходит, и на чём именно споткнулось.

   Ошибка одной заметки не отменяет остальные: список несделанного показывается
   в конце, повторить можно по тому же набору. */
function massOp(kind, paths, done) {
  const wrap = $('#modal');
  const titles = paths.map(p => corpus.byPath.get(p)?.title || p);
  const forms = {
    tag: { hd: 'ДОБАВИТЬ ТЕГ', lbl: 'ТЕГ (МОЖНО ВЛОЖЕННЫЙ: ПРОЕКТ/ЕРЕВАН)', ph: 'проект/ереван', ok: 'ПОСТАВИТЬ ВСЕМ' },
    untag: { hd: 'СНЯТЬ ТЕГ', lbl: 'КАКОЙ ТЕГ СНЯТЬ', ph: 'черновик', ok: 'СНЯТЬ СО ВСЕХ' },
    link: { hd: 'СВЯЗАТЬ С ЗАМЕТКОЙ', lbl: 'ИМЯ ЗАМЕТКИ, С КОТОРОЙ СВЯЗАТЬ', ph: 'Студия Полякова', ok: 'СВЯЗАТЬ ВСЕ' },
    field: { hd: 'ПОСТАВИТЬ ПОЛЕ', lbl: 'ПОЛЕ И ЗНАЧЕНИЕ ЧЕРЕЗ ДВОЕТОЧИЕ', ph: 'status: done', ok: 'ПРОСТАВИТЬ ВСЕМ' },
  };
  const f = forms[kind];
  const suggest = kind === 'tag' || kind === 'untag'
    ? [...corpus.tagCounts].slice(0, 12).map(([t]) => t)
    : kind === 'link' ? corpus.notes.filter(n => n.deg > 2).slice(0, 10).map(n => n.title) : ['status: done', 'status: активно', 'type: note'];

  wrap.innerHTML = `<div class="cap" style="width:600px"><div class="hd">${f.hd} · ${paths.length} ${plural(paths.length, 'ЗАМЕТКА', 'ЗАМЕТКИ', 'ЗАМЕТОК')}<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="row"><label style="flex:1"><span class="lbl">${f.lbl}</span><input id="mo-in" placeholder="${escA(f.ph)}" spellcheck="false"></label></div>
    ${kind === 'link' ? `<div class="row" style="padding-top:0"><label style="flex:1"><span class="lbl">ТИП СВЯЗИ</span>
      <select id="mo-field">${LINK_TYPES.map(t => `<option value="${t.key}">${t.label}</option>`).join('')}</select></label></div>` : ''}
    <div class="hint-row" style="display:flex;gap:5px;flex-wrap:wrap">${suggest.map(s => `<button class="chip" data-sg="${escA(s)}">${escA(s)}</button>`).join('')}</div>
    <div class="ask-ctx" style="max-height:26vh;overflow:auto;margin:6px 14px;font-size:10px;color:var(--mid)">${titles.map(t => `<div>${escA(t)}</div>`).join('')}</div>
    <div class="search-stats" id="mo-progress" style="padding:0 14px"></div>
    <div class="ft"><button class="btn-amber" style="margin:0" id="mo-ok">${f.ok}</button><button class="btn-line" id="mo-no">ОТМЕНА</button></div></div>`;
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  const input = $('#mo-in', wrap), progress = $('#mo-progress', wrap);
  setTimeout(() => input.focus(), 30);
  wrap.querySelectorAll('[data-sg]').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.sg; input.focus(); }));
  $('#mo-no', wrap).addEventListener('click', close);
  $('#mo-ok', wrap).addEventListener('click', async () => {
    const v = input.value.trim();
    if (!v) return toast('ПУСТОЕ ЗНАЧЕНИЕ', 'warn');
    let key = v, value = '';
    if (kind === 'field') {
      const m = v.match(/^([\wА-Яа-яЁё-]+)\s*[:=]\s*(.+)$/);
      if (!m) return toast('НУЖНО «ПОЛЕ: ЗНАЧЕНИЕ»', 'warn');
      key = m[1]; value = m[2];
    }
    const btn = $('#mo-ok', wrap); btn.disabled = true; btn.textContent = 'ПИШУ…';
    const failed = [];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      progress.textContent = `${i + 1} / ${paths.length} · ${corpus.byPath.get(p)?.title || p}`;
      try {
        if (kind === 'tag') await toggleTag(p, key.replace(/^#/, ''), true);
        else if (kind === 'untag') await toggleTag(p, key.replace(/^#/, ''), false);
        else if (kind === 'link') await linkTo(p, $('#mo-field', wrap).value, key);
        else await setNoteField(p, key, value);
      } catch (e) { failed.push(`${corpus.byPath.get(p)?.title || p}: ${e.message}`); }
    }
    progress.innerHTML = failed.length
      ? `<span style="color:var(--red)">НЕ ВЫШЛО У ${failed.length}:</span><br>${failed.slice(0, 6).map(escA).join('<br>')}`
      : '';
    toast(`ГОТОВО: ${paths.length - failed.length} ИЗ ${paths.length}${failed.length ? ` · ОШИБОК ${failed.length}` : ''}`, failed.length ? 'warn' : '', 6000);
    btn.disabled = false; btn.textContent = f.ok;
    if (!failed.length) { close(); done(); }
  });
  wrap.classList.add('open');
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
}

/* Все теги вальта разом: с чего начинается наведение порядка. Отсюда же
   переименование и слияние — на десяти тысячах заметок теги без этого
   расползаются на «ереван», «Ереван» и «переезд/ереван», и ни один фильтр не
   показывает всё сразу. */
function showAllTags() {
  const wrap = $('#modal');
  const all = [...corpus.tagCounts];
  const draw = () => {
    wrap.innerHTML = `<div class="cap" style="width:680px"><div class="hd">ТЕГИ ВАЛЬТА · ${all.length}<span>ESC — ЗАКРЫТЬ</span></div>
      <div class="hint-row">клик — отфильтровать картотеку · ✎ — переименовать или слить во всём вальте</div>
      <div class="ask-ctx" style="max-height:52vh;overflow:auto;margin:10px 14px">
        ${all.length ? all.map(([t, n]) => `<div class="trow" style="grid-template-columns:1fr 70px 40px">
          <span class="nm" data-pick="${escA(t)}" style="cursor:pointer">#${escA(t)}</span>
          <span>${n} ${plural(n, 'ЗАМЕТКА', 'ЗАМЕТКИ', 'ЗАМЕТОК')}</span>
          <span data-ren="${escA(t)}" style="cursor:pointer;color:var(--amber)" title="переименовать по всему вальту">✎</span>
        </div>`).join('') : '<div style="color:var(--dim);font-size:11px;padding:10px 0">тегов пока нет — поставьте первый на экране заметки</div>'}
      </div>
      <div class="ft"><button class="btn-line" id="tl-close">ЗАКРЫТЬ</button>
        <span class="note">теги живут во фронтматтере и видны Obsidian</span></div></div>`;
    wrap.querySelectorAll('[data-pick]').forEach(x => x.addEventListener('click', () => {
      close(); location.hash = `#/cards?tag=${encodeURIComponent(x.dataset.pick)}`;
    }));
    wrap.querySelectorAll('[data-ren]').forEach(x => x.addEventListener('click', () => renameTagFlow(x.dataset.ren, close)));
    $('#tl-close', wrap).addEventListener('click', close);
  };
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  draw();
  wrap.classList.add('open');
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
}

// Переименование идёт по всем заметкам с этим тегом: это единственная операция,
// которая правит десятки файлов разом, поэтому показывается счёт и предупреждение.
function renameTagFlow(tag, closeParent) {
  const notes = corpus.notes.filter(n => (n.tags || []).includes(tag));
  const wrap = $('#modal');
  wrap.innerHTML = `<div class="cap"><div class="hd">ПЕРЕИМЕНОВАТЬ ТЕГ #${escA(tag)}<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="row"><label><span class="lbl">НОВОЕ ИМЯ (ПУСТО — ПРОСТО СНЯТЬ ТЕГ)</span>
      <input id="rt-in" value="${escA(tag)}" spellcheck="false"></label></div>
    <div class="hint-row">затронет <b style="color:var(--amber-l)">${notes.length}</b> ${plural(notes.length, 'заметку', 'заметки', 'заметок')} · если такой тег уже есть, теги сольются</div>
    <div class="search-stats" id="rt-progress" style="padding:0 14px"></div>
    <div class="ft"><button class="btn-amber" style="margin:0" id="rt-ok">ПЕРЕИМЕНОВАТЬ</button><button class="btn-line" id="rt-no">ОТМЕНА</button></div></div>`;
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  const input = $('#rt-in', wrap), progress = $('#rt-progress', wrap);
  setTimeout(() => input.focus(), 30);
  $('#rt-no', wrap).addEventListener('click', close);
  $('#rt-ok', wrap).addEventListener('click', async () => {
    const to = input.value.trim();
    if (to === tag) return close();
    $('#rt-ok', wrap).textContent = 'ПРАВЛЮ…';
    try {
      const r = await renameTag(notes.map(n => n.path), tag, to,
        (done, total, path) => { progress.innerHTML = `<span>${done} / ${total}</span><span>${path}</span>`; });
      close();
      toast(`ТЕГ ${to ? `#${tag} → #${to}` : `#${tag} СНЯТ`} · ЗАМЕТОК ИЗМЕНЕНО: ${r.changed}`, '', 6000);
    } catch (e) {
      $('#rt-ok', wrap).textContent = 'ПЕРЕИМЕНОВАТЬ';
      toast(`НЕ ВЫШЛО: ${e.message}`, 'err');
    }
  });
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* ── поиск ───────────────────────────────────────────────────────────────────
   Два источника, одна выдача.

   ПАМЯТЬ — поиск по корпусу, который и так лежит в браузере: отвечает по мере
   набора, работает офлайн, ранжирует ровно тем же кодом, что воркер (js/search.js
   — порт worker.js). СЕРВЕР — настоящий vault_search: он видит свежие правки
   раньше, чем приложение перечитает индекс, и служит сверкой.

   Разбор серверной выдачи идёт ПО СТРОКАМ, начинающимся с `**путь**`, а не по
   пустым строкам: фрагменты многострочные, внутри них пустые строки встречаются,
   и разбиение по ним рвало один результат на два. */
const searchState = { mode: 'local' };

export function renderSearch(root, q) {
  root.innerHTML = `<div class="search-wrap"><div class="search-col">
    <div class="search-box"><span style="color:var(--amber);font-size:15px">⌕</span>
      <input id="s-q" placeholder="слова, или tag:ереван type:task -is:done after:2026-06" value="${escA(q || '')}" spellcheck="false" title="фильтры: ${Object.entries(FIELDS).map(([k, v]) => k + ' — ' + v).join('\n')}">
      <span class="seg" style="display:flex;gap:0">
        <button class="chip" data-m="local" title="по корпусу в браузере — мгновенно и офлайн">ПАМЯТЬ</button>
        <button class="chip" data-m="server" title="vault_search на воркере — видит свежие правки">СЕРВЕР</button>
      </span>
      <button class="chip" id="s-vec" title="смысловой слой: находит по описанию, когда слово забыто">✦ СМЫСЛ</button></div>
    <div class="search-stats" id="s-stats"></div>
    <div id="s-entity"></div>
    <div id="s-results"></div>
    <div class="srv-hint" id="s-hint" hidden></div></div></div>`;
  const input = $('#s-q', root), resBox = $('#s-results', root), stats = $('#s-stats', root), hint = $('#s-hint', root);
  const markMode = () => {
    root.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === searchState.mode));
    $('#s-vec', root).classList.toggle('on', getEmbedSettings().on);
  };
  $('#s-vec', root).addEventListener('click', () => embedSettings(markMode));
  input.focus();

  const rowsHtml = rows => rows.map(r => {
    const n = corpus.byPath.get(r.path);
    const color = n ? n.zoneRef.color : 'var(--dim)';
    return `<div class="result" data-p="${escA(r.path)}">
      <div class="path"><span style="color:${color}">■</span><span style="color:var(--text)">${n ? n.title : r.path}</span>
        ${r.chain ? `<span style="color:#454c60">›</span><span>${escA(r.chain)}</span>` : ''}
        ${r.more ? `<span style="color:#454c60;margin-left:auto">+${r.more} ${plural(r.more, 'ФРАГМЕНТ', 'ФРАГМЕНТА', 'ФРАГМЕНТОВ')}</span>` : ''}</div>
      <div class="frag">${r.fragHtml}</div></div>`;
  }).join('');

  const wire = () => resBox.querySelectorAll('.result').forEach(r => r.addEventListener('click', () => {
    const n = corpus.byPath.get(r.dataset.p);
    if (n) openNote(n); else toast('заметки нет в индексе — возможно, он ещё пересобирается', 'warn');
  }));

  // чистим фрагмент от разметки: скобки wikilink, звёздочки, маркер списка
  const cleanFrag = s => s
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m, t, a) => a || t)
    .replace(/\*\*/g, '').replace(/^(?:[-*]|>)\s+/gm, '');

  /* Сущностный блок над выдачей. Вопрос к личной памяти почти всегда про
     кого-то или про что-то, и правильный ответ на него — не фрагмент текста, а
     то, что про эту сущность известно. Поэтому блок стоит выше обычной выдачи,
     а не смешивается с ней: это ответ другого рода. */
  function drawEntity(query) {
    const box = $('#s-entity', root);
    const answers = query.trim() ? entityAnswer(query) : null;
    if (!answers || !answers.length) { box.innerHTML = ''; return; }
    box.innerHTML = answers.slice(0, 2).map(a => {
      const dead = c => c.status === 'отменено' || c.status === 'устарело';
      return `<div class="ent-card">
        <div class="ent-hd"><span style="color:${a.entity.zoneRef?.color || 'var(--amber)'}">■</span>
          <b data-p="${escA(a.entity.path)}">${a.entity.title}${
            // В заголовке заметки может стоять прозвище («pipipupu»), а искали
            // по имени файла — показываем и его, иначе непонятно, кто это.
            norm2(a.entity.base) !== norm2(a.entity.title) ? ` <span style="color:var(--dim);font-weight:400">· ${escA(a.entity.base)}</span>` : ''}</b>
          <span class="zn">${escA((a.entity.kind || 'сущность').toUpperCase())}</span>
          <span class="sp"></span><span class="zn">${a.total} ${plural(a.total, 'УТВЕРЖДЕНИЕ', 'УТВЕРЖДЕНИЯ', 'УТВЕРЖДЕНИЙ')}</span></div>
        ${a.claims.length ? `<div class="ent-claims">${a.claims.map(c => `<div data-p="${escA(c.path)}">
          <span class="w" style="${dead(c) ? 'text-decoration:line-through;opacity:.55' : ''}">${escA(c.title.replace(/^\d{4}-\d{2}-\d{2}\s+/, ''))}</span>
          <span class="zn">${escA(c.kind || '')} · ${escA(String(c.when || '').slice(0, 10))}</span></div>`).join('')}</div>`
          : '<div class="ent-claims"><div style="cursor:default;color:var(--dim)">про неё ещё ничего не извлечено</div></div>'}
        ${a.near.length ? `<div class="ent-near">РЯДОМ: ${a.near.map(n => `<span data-p="${escA(n.note.path)}">${n.note.title}</span>`).join(' · ')}</div>` : ''}
      </div>`;
    }).join('');
    box.querySelectorAll('[data-p]').forEach(el2 => el2.addEventListener('click', () => {
      location.hash = `#/note/${encodeURIComponent(el2.dataset.p)}`;
    }));
  }

  async function runLocal(query) {
    const t0 = performance.now();
    drawEntity(query);
    // Запрос может быть чисто фильтрующим: «type:task -is:done» без единого
    // слова. Тогда искать нечего — просто отбираем по свойствам из карты.
    const q = parseQuery(query);
    if (!q.text.trim()) {
      const list = filterNotes(q).sort((a, b) => new Date(b.meta.h || 0) - new Date(a.meta.h || 0)).slice(0, 200);
      stats.innerHTML = `<span style="color:var(--amber-l)">${list.length} ${plural(list.length, 'ЗАМЕТКА', 'ЗАМЕТКИ', 'ЗАМЕТОК')}</span>`
        + `<span>${Math.round(performance.now() - t0)} МС · ФИЛЬТР ${describe(q).toUpperCase()}</span>`;
      resBox.innerHTML = rowsHtml(list.map(n => ({ path: n.path, title: n.title, chain: '', fragHtml: `<span style="color:var(--dim)">${(n.tags || []).map(t => '#' + t).join(' ') || n.zone}</span>` })));
      hint.hidden = true;
      wire();
      return;
    }
    const { results: all, terms } = await searchCorpus(q.text, 60);
    const results = (hasFilters(q) ? all.filter(r => { const n = corpus.byPath.get(r.path); return n && matches(n, q); }) : all).slice(0, 25);
    const found = Math.round(performance.now() - t0);
    // Фрагменты стоят чтения файлов, поэтому подтягиваются только для верхних
    // результатов: остальное человек всё равно не увидит без прокрутки.
    await withSnippets(results, terms, 6);
    const ms = performance.now() - t0;
    stats.innerHTML = `<span style="color:var(--amber-l)">${results.length} ${plural(results.length, 'СОВПАДЕНИЕ', 'СОВПАДЕНИЯ', 'СОВПАДЕНИЙ')}</span>`
      + `<span>${found} МС ПОИСК · ${Math.round(ms)} МС С ФРАГМЕНТАМИ</span><span style="margin-left:auto">ENTER — ОТКРЫТЬ ПЕРВОЕ</span>`;
    resBox.innerHTML = rowsHtml(results.map(r => ({ ...r, fragHtml: r.frag ? markTerms(escA(cleanFrag(r.frag)), terms) : '<span style="color:var(--dim)">…</span>' })));
    hint.hidden = results.length > 0;
    if (!results.length) { hint.hidden = false; hint.textContent = 'В ПАМЯТИ НЕ НАЙДЕНО. ПОПРОБУЙТЕ СЕРВЕР — ОН ВИДИТ ПРАВКИ, КОТОРЫЕ ЕЩЁ НЕ ПОПАЛИ В ИНДЕКС ПРИЛОЖЕНИЯ.'; }
    wire();
  }

  async function runServer(query) {
    stats.innerHTML = `<span>ИЩУ НА СЕРВЕРЕ…</span>`; resBox.innerHTML = ''; hint.hidden = true;
    const t0 = performance.now();
    try {
      const text = await tools.search(query, 20);
      const { results, tail } = parseServerSearch(text);
      stats.innerHTML = `<span style="color:var(--amber-l)">${results.length} ${plural(results.length, 'СОВПАДЕНИЕ', 'СОВПАДЕНИЯ', 'СОВПАДЕНИЙ')}</span>`
        + `<span>${((performance.now() - t0) / 1000).toFixed(2).replace('.', ',')} С · VAULT_SEARCH</span><span style="margin-left:auto">ENTER — ОТКРЫТЬ ПЕРВОЕ</span>`;
      const terms = queryTerms(query, parseSynonyms(corpus.synonyms));
      resBox.innerHTML = rowsHtml(results.map(r => ({ ...r, fragHtml: markTerms(escA(cleanFrag(r.frag)), terms) })));
      if (tail) { hint.hidden = false; hint.textContent = 'ПОДСКАЗКА СЕРВЕРА: ' + tail; }
      wire();
    } catch (e) { stats.innerHTML = `<span style="color:var(--red)">ОШИБКА: ${e.message}</span>`; }
  }

  const run = () => {
    const query = input.value.trim();
    if (!query) { resBox.innerHTML = ''; stats.innerHTML = ''; hint.hidden = true; return; }
    location.hash = `#/search?q=${encodeURIComponent(query)}`;
    searchState.mode === 'server' ? runServer(query) : runLocal(query);
  };

  // локальный поиск успевает за набором: 1600 кусков ранжируются за единицы мс
  let typeTimer = null;
  input.addEventListener('input', () => {
    if (searchState.mode !== 'local') return;
    clearTimeout(typeTimer);
    typeTimer = setTimeout(run, 90);
  });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const q2 = input.value.trim();
    if (q2 && q2 !== root.dataset.last) { root.dataset.last = q2; run(); }
    else { const first = $('.result', resBox); if (first) first.click(); }
  });
  root.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => {
    searchState.mode = b.dataset.m; markMode(); run(); input.focus();
  }));
  markMode();
  if (q) { root.dataset.last = q; run(); }
}

/* ── спросить память ─────────────────────────────────────────────────────────
   Экран показывает не только ответ, но и ФРАГМЕНТЫ, на которых он построен, —
   иначе получается вторая память рядом с первой, и проверить ответ нечем.
   Три пути: пакет в буфер (работает всегда), ответ прямо здесь (нужен ключ
   Anthropic), подключение вальта к другим ИИ как MCP-сервера. */
const askState = { mode: 'fast', full: false, last: null };

export function renderAsk(root, q) {
  const s = getAiSettings();
  root.innerHTML = `<div class="search-wrap"><div class="search-col ask">
    <div class="search-box"><span style="color:var(--amber);font-size:15px">✦</span>
      <input id="a-q" placeholder="спросить у памяти…" value="${escA(q || '')}" spellcheck="false">
      <span class="seg" style="display:flex;gap:0">
        <button class="chip ${askState.mode === 'fast' ? 'on' : ''}" data-am="fast" title="извлечь из фрагментов — дёшево и быстро">БЫСТРО</button>
        <button class="chip ${askState.mode === 'deep' ? 'on' : ''}" data-am="deep" title="рассуждать над противоречиями — дороже и дольше">ТЩАТЕЛЬНО</button>
      </span></div>
    <div class="ask-bar">
      <button class="btn-amber" style="margin:0" id="a-run">${s.key ? 'ОТВЕТИТЬ ЗДЕСЬ [ENTER]' : 'СОБРАТЬ КОНТЕКСТ [ENTER]'}</button>
      <button class="btn-line" id="a-copy">КОПИРОВАТЬ ПАКЕТ</button>
      <button class="btn-line" id="a-chat">ОТКРЫТЬ CLAUDE.AI</button>
      <label class="lbl" style="display:flex;align-items:center;gap:6px;cursor:pointer;letter-spacing:.1em">
        <input type="checkbox" id="a-full" ${askState.full ? 'checked' : ''} style="width:auto"> ЗАМЕТКИ ЦЕЛИКОМ</label>
      <span class="sp"></span>
      <button class="btn-line" id="a-keys">⚙ КЛЮЧ И MCP</button>
    </div>
    <div class="search-stats" id="a-stats"></div>
    <div class="ask-answer" id="a-answer" hidden></div>
    <div class="ask-ctx" id="a-ctx"></div>
  </div></div>`;

  const input = $('#a-q', root), stats = $('#a-stats', root), ansBox = $('#a-answer', root), ctxBox = $('#a-ctx', root);
  input.focus();

  const drawCtx = ctx => {
    ctxBox.innerHTML = `<div class="ask-ctx-hd">В КОНТЕКСТ ПОЙДЁТ ${ctx.results.length} ${plural(ctx.results.length, 'ФРАГМЕНТ', 'ФРАГМЕНТА', 'ФРАГМЕНТОВ')} · ≈${ctx.tokensRough} ТОКЕНОВ</div>` +
      ctx.results.map(r => {
        const n = corpus.byPath.get(r.path);
        return `<div class="result" data-p="${escA(r.path)}">
          <div class="path"><span style="color:${n ? n.zoneRef.color : 'var(--dim)'}">■</span><span style="color:var(--text)">${n ? n.title : r.path}</span>
            ${r.chain ? `<span style="color:#454c60">›</span><span>${escA(r.chain)}</span>` : ''}</div>
          <div class="frag">${escA(r.frag).slice(0, 400)}</div></div>`;
      }).join('');
    ctxBox.querySelectorAll('[data-p]').forEach(el2 => el2.addEventListener('click', () => {
      const n = corpus.byPath.get(el2.dataset.p); if (n) openNote(n);
    }));
  };

  const collect = async () => {
    const question = input.value.trim();
    if (!question) return null;
    stats.innerHTML = '<span>СОБИРАЮ КОНТЕКСТ…</span>';
    const ctx = await buildContext(question, { full: $('#a-full', root).checked });
    askState.last = { question, ctx };
    drawCtx(ctx);
    if (!ctx.results.length) stats.innerHTML = `<span style="color:var(--red)">В ПАМЯТИ НИЧЕГО НЕ НАЙДЕНО ПО ЭТОМУ ВОПРОСУ</span>`;
    return askState.last;
  };

  async function run() {
    const cur = await collect();
    if (!cur) return;
    if (!getAiSettings().key) {
      stats.innerHTML = `<span style="color:var(--amber-l)">КОНТЕКСТ СОБРАН</span><span>КОПИРУЙТЕ ПАКЕТ ИЛИ ДОБАВЬТЕ КЛЮЧ ANTHROPIC В «⚙ КЛЮЧ И MCP»</span>`;
      return;
    }
    ansBox.hidden = false;
    ansBox.innerHTML = '<div class="md"></div>';
    const md = $('.md', ansBox);
    stats.innerHTML = `<span>СПРАШИВАЮ ${MODEL.toUpperCase()}…</span>`;
    const t0 = performance.now();
    let raw = '';
    try {
      await askClaude(cur.question, cur.ctx, {
        mode: askState.mode,
        onText: (_, all) => { raw = all; md.innerHTML = renderMd(all); },
      });
      stats.innerHTML = `<span style="color:var(--amber-l)">ОТВЕТ ГОТОВ</span><span>${((performance.now() - t0) / 1000).toFixed(1)} С · ${MODEL.toUpperCase()} · ${MODES[askState.mode].label}</span>`;
      wireWikiLinks(ansBox);
      const foot = el('div', 'ask-foot');
      foot.innerHTML = `<button class="btn-line" data-save>ЗАПИСАТЬ ОТВЕТ В ДЕНЬ</button><span class="note">ответ построен только на фрагментах выше</span>`;
      ansBox.appendChild(foot);
      $('[data-save]', foot).addEventListener('click', async () => {
        try {
          const { path } = await appendThought(`**${cur.question}** — ${raw.replace(/\n+/g, ' ').slice(0, 900)}`);
          toast(`ЗАПИСАНО → ${path.toUpperCase()}`);
        } catch (e) { toast(`НЕ ЗАПИСАЛОСЬ: ${e.message}`, 'err'); }
      });
    } catch (e) {
      stats.innerHTML = `<span style="color:var(--red)">${e.message.toUpperCase()}</span>`;
    }
  }

  const copyPack = async () => {
    const cur = await collect(); if (!cur) return;
    try {
      await navigator.clipboard.writeText(packForChat(cur.question, cur.ctx));
      toast(`ПАКЕТ В БУФЕРЕ · ${cur.ctx.results.length} ${plural(cur.ctx.results.length, 'ФРАГМЕНТ', 'ФРАГМЕНТА', 'ФРАГМЕНТОВ')} · ВСТАВЬТЕ В ЛЮБОЙ ЧАТ`);
    } catch { toast('БУФЕР НЕДОСТУПЕН — РАЗРЕШИТЕ ДОСТУП В БРАУЗЕРЕ', 'err'); }
  };

  $('#a-run', root).addEventListener('click', run);
  $('#a-copy', root).addEventListener('click', copyPack);
  $('#a-chat', root).addEventListener('click', async () => {
    await copyPack();
    open('https://claude.ai/new', '_blank', 'noopener');
  });
  $('#a-full', root).addEventListener('change', e => { askState.full = e.target.checked; if (askState.last) collect(); });
  askState.mode = askState.mode || 'fast';
  root.querySelectorAll('[data-am]').forEach(b => b.addEventListener('click', () => {
    askState.mode = b.dataset.am;
    root.querySelectorAll('[data-am]').forEach(x => x.classList.toggle('on', x === b));
  }));
  $('#a-keys', root).addEventListener('click', () => openAiSettings(() => renderAsk(root, input.value.trim())));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  if (q) { input.value = q; run(); }
}

// Ключ и адреса — в одном месте: и для ответа «здесь», и для подключения
// вальта к сторонним ИИ по MCP.
function openAiSettings(onClose) {
  const wrap = $('#modal');
  const s = getAiSettings();
  const url = (getSettings()?.url || DEFAULT_URL);
  wrap.innerHTML = `<div class="cap"><div class="hd">КЛЮЧ ANTHROPIC И ПОДКЛЮЧЕНИЕ ИИ<span>ESC — ЗАКРЫТЬ</span></div>
    <div class="row"><label><span class="lbl">КЛЮЧ ANTHROPIC (ДЛЯ ОТВЕТА ПРЯМО ЗДЕСЬ)</span>
      <input id="ai-key" type="password" placeholder="sk-ant-…" value="${escA(s.key || '')}" spellcheck="false"></label></div>
    <div class="hint-row">Живёт только в localStorage этого устройства и уходит напрямую в api.anthropic.com. Это отдельная оплата по API — подписка Claude ключ не даёт. Без ключа приложение работает: собирает пакет контекста для любого чата.</div>
    <div class="row"><label><span class="lbl">ВАЛЬТ КАК MCP-СЕРВЕР ДЛЯ ЛЮБОГО ИИ</span>
      <input id="ai-mcp" value="${escA(url)}" spellcheck="false" readonly></label></div>
    <div class="hint-row">Тот же адрес, что у приложения. Секрет подставьте свой — в конфиг он не записан.</div>
    <div class="ft"><button class="btn-amber" style="margin:0" id="ai-save">СОХРАНИТЬ</button>
      <button class="btn-line" id="ai-forget">ЗАБЫТЬ КЛЮЧ</button>
      <button class="btn-line" id="ai-copy-mcp">КОПИРОВАТЬ MCP-КОНФИГ</button>
      <span class="note">ключ в браузере доступен любому, у кого есть это устройство</span></div></div>`;
  wrap.classList.add('open');
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); onClose && onClose(); };
  $('#ai-save', wrap).addEventListener('click', () => { saveAiSettings({ key: $('#ai-key', wrap).value.trim() }); toast('СОХРАНЕНО'); close(); });
  $('#ai-forget', wrap).addEventListener('click', () => { forgetKey(); toast('КЛЮЧ УДАЛЁН С ЭТОГО УСТРОЙСТВА'); close(); });
  $('#ai-copy-mcp', wrap).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(mcpConfig(url)); toast('КОНФИГ В БУФЕРЕ · ПОДСТАВЬТЕ СЕКРЕТ'); }
    catch { toast('БУФЕР НЕДОСТУПЕН', 'err'); }
  });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
}

/* ── командная палитра ───────────────────────────────────────────────────────
   Один вход во всё: заметки по названию, фильтры, действия. На десяти тысячах
   заметок навигация мышью по спискам перестаёт работать — быстрее набрать три
   буквы, чем найти строку глазами. */
export function initPalette() {
  const wrap = $('#palette');
  const COMMANDS = [
    { label: 'Быстрая мысль', hint: 'N', run: () => document.getElementById('btn-capture').click() },
    { label: 'Новая заметка', hint: 'C', run: () => document.getElementById('btn-new').click() },
    { label: 'Спросить память', hint: '', run: () => { location.hash = '#/ask'; } },
    { label: 'Здоровье вальта', hint: 'сироты, битые, застой', run: () => { location.hash = '#/health'; } },
    { label: 'Разбор', hint: 'неразмеченное по одной', run: () => { location.hash = '#/triage'; } },
    { label: 'Лента', hint: 'по времени правок', run: () => { location.hash = '#/time'; } },
    { label: 'Люди', hint: 'кто и где упоминается', run: () => { location.hash = '#/people'; } },
    { label: 'Сводка за неделю', hint: 'что было и что подвисло', run: () => aiDigest(7) },
    { label: 'Сводка за месяц', hint: 'то же, шире', run: () => aiDigest(30) },
    { label: 'Все теги', hint: 'переименование и слияние', run: () => showAllTags() },
    { label: 'Карта', hint: 'G', run: () => { location.hash = '#/graph'; } },
    { label: 'Картотека', hint: 'K', run: () => { location.hash = '#/cards'; } },
    { label: 'Заметки-сироты', hint: 'is:orphan', run: () => { location.hash = '#/search?q=' + encodeURIComponent('is:orphan'); } },
    { label: 'Битые ссылки', hint: 'is:broken', run: () => { location.hash = '#/search?q=' + encodeURIComponent('is:broken'); } },
    { label: 'Без тегов', hint: 'is:untagged', run: () => { location.hash = '#/search?q=' + encodeURIComponent('is:untagged') } },
  ];
  wrap.innerHTML = `<div class="palette"><input id="pl-in" placeholder="куда идём? заметка, фильтр или действие" spellcheck="false" autocomplete="off">
    <div class="pl-list" id="pl-list"></div>
    <div class="pl-foot">↑↓ — выбор · ENTER — открыть · ESC — закрыть</div></div>`;
  const input = $('#pl-in', wrap), list = $('#pl-list', wrap);
  let items = [], sel = 0;

  const build = () => {
    const q = input.value.trim().toLowerCase();
    const notes = (q ? corpus.notes.filter(n => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      : corpus.notes.slice().sort((a, b) => new Date(b.meta.h || 0) - new Date(a.meta.h || 0)))
      .slice(0, 12)
      .map(n => ({ label: n.title, hint: `${zn(n)} · ${fmtAge(n.meta.h)}`, dot: n.zoneRef?.color, run: () => openNote(n) }));
    const cmds = COMMANDS.filter(c => !q || c.label.toLowerCase().includes(q));
    items = q ? [...notes, ...cmds] : [...cmds, ...notes];
    sel = 0;
    draw();
  };
  const draw = () => {
    list.innerHTML = items.map((it, i) => `<div class="pl-row ${i === sel ? 'sel' : ''}" data-i="${i}">
      ${it.dot ? `<span class="dot glow" style="background:${it.dot};color:${it.dot}"></span>` : '<span class="pl-cmd">▸</span>'}
      <span class="nm">${escA(it.label)}</span><span class="hint">${escA(it.hint || '')}</span></div>`).join('')
      || '<div class="pl-row" style="color:var(--dim)">ничего не нашлось</div>';
    list.querySelectorAll('[data-i]').forEach(r => r.addEventListener('click', () => { const it = items[+r.dataset.i]; close(); it.run(); }));
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  };
  const open = () => { wrap.classList.add('open'); input.value = ''; build(); setTimeout(() => input.focus(), 20); };
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };

  input.addEventListener('input', build);
  wrap.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === 'Enter') { const it = items[sel]; if (it) { close(); it.run(); } }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  return { open, close };
}

/* ── здоровье вальта ─────────────────────────────────────────────────────────
   Что накопилось и требует руки: заметки, на которые никто не ссылается,
   ссылки в пустоту, застоявшееся, разросшееся, неразобранное. На двух сотнях
   это видно глазами; дальше — только списком. */
export function renderHealth(root) {
  const notes = corpus.notes.filter(isVisible);
  const now = Date.now();
  const age = n => (now - Date.parse(n.meta.h || n.meta.u || 0)) / 864e5;

  const groups = [
    { key: 'broken', title: 'БИТЫЕ ССЫЛКИ', hint: 'ссылка есть, заметки нет — либо создать, либо убрать',
      items: notes.filter(n => n.broken?.length).map(n => ({ n, extra: n.broken.slice(0, 3).join(', ') })) },
    { key: 'orphan', title: 'СИРОТЫ', hint: 'никто не ссылается — заметка выпала из памяти',
      items: notes.filter(n => !n.backlinks?.length && !n.zoneRef?.chronicle).map(n => ({ n, extra: `${n.links.length} исходящих` })) },
    { key: 'untagged', title: 'БЕЗ ТЕГОВ И СВЯЗЕЙ', hint: 'нечем найти, кроме слов — кандидаты на разбор',
      items: notes.filter(n => !n.tags?.length && !n.links.length && !n.backlinks?.length).map(n => ({ n, extra: fmtBytes(n.meta.b) })) },
    { key: 'stale', title: 'ЗАСТОЙ ПОЛГОДА', hint: 'не трогалось давно — перечитать или отпустить в архив',
      items: notes.filter(n => age(n) > 180 && !n.zoneRef?.chronicle).map(n => ({ n, extra: fmtAge(n.meta.h) })) },
    { key: 'huge', title: 'РАЗРОСЛИСЬ', hint: 'больше 20 КБ — пора делить на части',
      items: notes.filter(n => (n.meta.b || 0) > 20000).map(n => ({ n, extra: fmtBytes(n.meta.b) })) },
  ];

  const lonelyTags = [...corpus.tagCounts].filter(([, c]) => c === 1);

  root.innerHTML = `<div class="cards-wrap"><div class="toolbar">
      <span class="lbl">ЗДОРОВЬЕ ВАЛЬТА</span>
      <span style="font-size:10px;color:var(--mid)">${notes.length} ${plural(notes.length, 'заметка', 'заметки', 'заметок')} в работе · теги: ${corpus.tagCounts.size}${lonelyTags.length ? ` (одиночек ${lonelyTags.length})` : ''}</span>
      <span class="sp"></span>
      <span style="font-size:10px;color:var(--dim)">клик по строке — открыть заметку</span>
    </div>
    <div class="cards-body"><div class="health">${groups.map(g => `
      <div class="panel health-block">
        <div class="hd">${g.title} · ${g.items.length}</div>
        <div style="padding:7px 12px;font-size:9.5px;color:var(--dim)">${g.hint}</div>
        <div class="rail-rows">${g.items.slice(0, 40).map(({ n, extra }) => `
          <div data-p="${escA(n.path)}">${zoneDot(n.zoneRef)}<span class="nm">${n.title}</span><span class="zn">${escA(String(extra))}</span></div>`).join('')
          || '<div style="cursor:default;color:var(--green);font-size:10px">чисто</div>'}
          ${g.items.length > 40 ? `<div style="cursor:default;color:var(--dim);font-size:10px">…и ещё ${g.items.length - 40}</div>` : ''}</div>
      </div>`).join('')}
      ${lonelyTags.length ? `<div class="panel health-block"><div class="hd">ТЕГИ-ОДИНОЧКИ · ${lonelyTags.length}</div>
        <div style="padding:7px 12px;font-size:9.5px;color:var(--dim)">поставлены один раз — обычно опечатка или дубль существующего</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;padding:10px 12px">${lonelyTags.map(([t]) => `<button class="chip" data-tag="${escA(t)}">#${escA(t)}</button>`).join('')}</div></div>` : ''}
    </div></div></div>`;

  root.querySelectorAll('[data-p]').forEach(r => r.addEventListener('click', () => { location.hash = `#/note/${encodeURIComponent(r.dataset.p)}`; }));
  root.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => { location.hash = `#/cards?tag=${encodeURIComponent(b.dataset.tag)}`; }));
}

/* ── разбор ──────────────────────────────────────────────────────────────────
   Заметка, которую записали и не связали ни с чем, через месяц не существует:
   найти её можно только точным словом, а вспомнить это слово нечем. Здесь такие
   заметки идут по одной, и на каждую есть готовые предложения — теги соседей и
   похожие заметки, — чтобы разбор стоил два нажатия, а не десять.

   «Отложить» живёт в localStorage, а не в вальте: это состояние головы, а не
   знание. Незачем засорять фронтматтер служебными флагами. */
const SKIP_KEY = 'shards.triage.skip';
const skipSet = () => { try { return new Set(JSON.parse(localStorage.getItem(SKIP_KEY)) || []); } catch { return new Set(); } };
const skipAdd = p => { const s = skipSet(); s.add(p); localStorage.setItem(SKIP_KEY, JSON.stringify([...s])); };

export async function renderTriage(root) {
  const skip = skipSet();
  const queue = corpus.notes
    .filter(n => isVisible(n) && !n.zoneRef?.chronicle && !skip.has(n.path)
      && (!n.tags?.length || (!n.links.length && !n.backlinks?.length)))
    .sort((a, b) => new Date(b.meta.h || 0) - new Date(a.meta.h || 0));

  root.innerHTML = `<div class="cards-wrap">
    <div class="toolbar"><span class="lbl">РАЗБОР</span>
      <span style="font-size:10px;color:var(--mid)" id="tr-count"></span>
      <span class="sp"></span>
      <button class="chip" id="tr-clearskip" title="вернуть отложенные в очередь">ОТЛОЖЕНО ${skip.size}</button>
      <span style="font-size:10px;color:var(--dim)">T — следующая · 1…9 — поставить предложенный тег</span></div>
    <div class="cards-body" id="tr-body"></div></div>`;

  $('#tr-clearskip', root).addEventListener('click', () => { localStorage.removeItem(SKIP_KEY); renderTriage(root); });

  let at = 0;
  const body = $('#tr-body', root);
  const step = async () => {
    const note = queue[at];
    $('#tr-count', root).textContent = queue.length ? `${at + 1} из ${queue.length} без тегов или без связей` : 'очередь пуста';
    if (!note) {
      body.innerHTML = `<div class="splash" style="position:static;padding:80px 0"><span class="gem"></span>
        <span class="st">РАЗБИРАТЬ НЕЧЕГО — ВСЁ СВЯЗАНО И РАЗМЕЧЕНО</span></div>`;
      return;
    }
    body.innerHTML = `<div class="triage">
      <div class="tr-card">
        <div class="note-meta"><span style="color:${note.zoneRef.color}">■ ${zn(note)}</span>
          <span>ПРАВКА ${fmtAge(note.meta.h).toUpperCase()}</span><span>${fmtBytes(note.meta.b)}</span>
          <span>${note.tags?.length ? '' : 'БЕЗ ТЕГОВ'} ${note.links.length + (note.backlinks?.length || 0) ? '' : '· БЕЗ СВЯЗЕЙ'}</span></div>
        <h1 class="note-title">${note.title}</h1>
        <div class="md" id="tr-text" style="max-height:34vh;overflow:auto">читаю…</div>
        <div class="tr-acts">
          <button class="btn-amber" id="tr-apply" style="margin:0">ПРИМЕНИТЬ ВЫБРАННОЕ</button>
          <button class="btn-line" id="tr-skip">ОТЛОЖИТЬ [T]</button>
          <button class="btn-line" id="tr-open">ОТКРЫТЬ ЦЕЛИКОМ</button>
        </div>
      </div>
      <div class="tr-side">
        <div class="panel"><div class="hd">ТЕГИ ПО СОСЕДЯМ</div><div id="tr-tags" style="display:flex;gap:5px;flex-wrap:wrap;padding:10px 12px">считаю…</div></div>
        <div class="panel"><div class="hd">СВЯЗАТЬ С ПОХОЖИМИ</div><div class="rail-rows" id="tr-links"></div></div>
      </div></div>`;

    $('#tr-skip', root).addEventListener('click', () => { skipAdd(note.path); at++; step(); });
    $('#tr-open', root).addEventListener('click', () => openNote(note));

    textOf(note).then(raw => {
      const { body: b } = splitFrontmatter(raw);
      $('#tr-text', root).innerHTML = renderMd(b.slice(0, 1200)) + (b.length > 1200 ? '<p style="color:var(--dim)">…</p>' : '');
    }).catch(() => { $('#tr-text', root).textContent = 'текст недоступен'; });

    // Предложения берём у похожих заметок: если пять соседей по смыслу помечены
    // #переезд, то и эта скорее всего про переезд. Это дешевле любой модели.
    const sim = await similarTo(note, 8).catch(() => []);
    const freq = new Map();
    for (const { note: o, score } of sim) for (const t of o.tags || []) freq.set(t, (freq.get(t) || 0) + score);
    const picks = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 9).map(x => x[0]);
    const chosen = new Set();
    const tagBox = $('#tr-tags', root);
    tagBox.innerHTML = picks.length
      ? picks.map((t, i) => `<button class="chip" data-t="${escA(t)}">${i + 1} · #${escA(t)}</button>`).join('')
        + '<button class="chip" data-t-new title="свой тег">＋ СВОЙ</button>'
      : '<span style="font-size:10px;color:var(--dim)">соседи ничем не помечены — поставьте тег руками на экране заметки</span>';
    const toggle = t => {
      chosen.has(t) ? chosen.delete(t) : chosen.add(t);
      tagBox.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', chosen.has(b.dataset.t)));
    };
    tagBox.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => toggle(b.dataset.t)));
    $('[data-t-new]', tagBox)?.addEventListener('click', () => askTag(note.path, () => step()));

    const linkBox = $('#tr-links', root);
    const linked = new Set();
    linkBox.innerHTML = sim.slice(0, 6).map(({ note: o }) => `<div data-l="${escA(o.title)}">${zoneDot(o.zoneRef)}<span class="nm">${o.title}</span><span class="zn">СВЯЗАТЬ</span></div>`).join('')
      || '<div style="cursor:default;color:var(--dim);font-size:10px">похожих не нашлось</div>';
    linkBox.querySelectorAll('[data-l]').forEach(r => r.addEventListener('click', () => {
      const t = r.dataset.l;
      linked.has(t) ? linked.delete(t) : linked.add(t);
      r.classList.toggle('picked', linked.has(t));
      $('.zn', r).textContent = linked.has(t) ? 'ВЫБРАНО' : 'СВЯЗАТЬ';
    }));

    root.onkeydown = e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 't' || e.key === 'е') { skipAdd(note.path); at++; step(); }
      const i = +e.key;
      if (i >= 1 && i <= picks.length) toggle(picks[i - 1]);
    };

    $('#tr-apply', root).addEventListener('click', async () => {
      if (!chosen.size && !linked.size) return toast('НИЧЕГО НЕ ВЫБРАНО', 'warn');
      const btn = $('#tr-apply', root); btn.disabled = true; btn.textContent = 'ПИШУ…';
      const errs = [];
      for (const t of chosen) try { await toggleTag(note.path, t, true); } catch (e) { errs.push(e.message); }
      for (const t of linked) try { await linkTo(note.path, 'relates', t); } catch (e) { errs.push(e.message); }
      toast(errs.length ? `ЧАСТИЧНО: ${errs[0]}` : `РАЗОБРАНО: ${note.title}`, errs.length ? 'warn' : '');
      at++; step();
    });
  };
  step();
}

/* ── лента ───────────────────────────────────────────────────────────────────
   Память имеет время: «что я делал в июле» — вопрос не хуже «что я думал про
   Ереван». Лента строится по дате последней правки из git, поэтому показывает
   не когда файл создан, а когда к нему возвращались. */
export function renderTimeline(root) {
  /* Дата берётся не только из git. Вальт переехал в репозиторий разом, поэтому
     по коммитам почти всё лежит в одном месяце — лента из двух столбиков.
     Если в имени или пути есть дата (daily/2026-07-16, «Разбор PT4 — 2026-07-23»),
     она вернее: это дата события, а не дата, когда файл положили в git. */
  const dateOf = n => {
    const m = (n.path + ' ' + n.title).match(/(20\d{2})-(\d{2})-(\d{2})/);
    if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3]); if (!isNaN(d)) return d; }
    return n.meta.h ? new Date(n.meta.h) : null;
  };
  const notes = corpus.notes.filter(n => isVisible(n) && dateOf(n));
  const when = new Map(notes.map(n => [n, dateOf(n)]));

  /* Шаг ленты подбирается под возраст вальта. Вальту два месяца — по месяцам это
     два столбика, и смотреть не на что; станет два года — по дням это семьсот
     заголовков. Порог по размаху дат, а не по числу заметок. */
  const stamps = [...when.values()].map(d => d.getTime());
  const spanDays = (Math.max(...stamps) - Math.min(...stamps)) / 864e5;
  const step = spanDays <= 120 ? 'day' : spanDays <= 3 * 365 ? 'month' : 'year';
  const pad = x => String(x).padStart(2, '0');
  const keyOf = d => step === 'day' ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    : step === 'month' ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}` : `${d.getFullYear()}`;
  const MONTH = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const label = key => {
    const [y, m, d] = key.split('-');
    if (step === 'year') return y;
    if (step === 'month') return `${MONTH[+m - 1].toUpperCase()} ${y}`;
    return `${+d} ${MONTH[+m - 1].toUpperCase()} ${y}`;
  };
  const byMonth = new Map();
  for (const n of notes) {
    const key = keyOf(when.get(n));
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(n);
  }
  const months = [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const peak = Math.max(...months.map(([, l]) => l.length), 1);

  root.innerHTML = `<div class="cards-wrap">
    <div class="toolbar"><span class="lbl">ЛЕНТА</span>
      <span style="font-size:10px;color:var(--mid)">${notes.length} ${plural(notes.length, 'заметка', 'заметки', 'заметок')} · ${months.length} ${step === 'day' ? plural(months.length, 'день', 'дня', 'дней') : step === 'month' ? plural(months.length, 'месяц', 'месяца', 'месяцев') : plural(months.length, 'год', 'года', 'лет')} · дата из имени, иначе последняя правка</span>
      <span class="sp"></span><span style="font-size:10px;color:var(--dim)">клик по столбику — перейти</span></div>
    <div class="cards-body">
      <div class="tl-bars">${months.slice().reverse().map(([k, l]) => `<span class="tl-bar" data-go="${k}" title="${label(k)} · ${l.length}">
        <i style="height:${Math.max(3, l.length / peak * 100)}%"></i></span>`).join('')}</div>
      ${months.map(([k, l]) => `<div class="tl-month" id="m-${k}">
        <div class="tl-hd">${label(k)}<span>${l.length} ${plural(l.length, 'ЗАМЕТКА', 'ЗАМЕТКИ', 'ЗАМЕТОК')}</span></div>
        <div class="rail-rows">${l.sort((a, b) => when.get(b) - when.get(a)).map(n => `
          <div data-p="${escA(n.path)}">${zoneDot(n.zoneRef)}<span class="nm">${n.title}</span>
            <span class="zn">${when.get(n).toLocaleDateString('ru', { day: 'numeric', month: 'short' })}</span></div>`).join('')}</div>
      </div>`).join('')}
    </div></div>`;
  root.querySelectorAll('[data-p]').forEach(r => r.addEventListener('click', () => { location.hash = `#/note/${encodeURIComponent(r.dataset.p)}`; }));
  root.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
    $(`#m-${b.dataset.go}`, root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

/* ── люди ────────────────────────────────────────────────────────────────────
   Отдельный экран, потому что люди — единственный тип заметок, который важен
   не содержимым, а тем, где ещё они всплывают: с кем связано, когда последний
   раз упоминался, в каких проектах. */
export function renderPeople(root) {
  const people = corpus.notes.filter(n => n.type === 'person')
    .map(n => {
      const mentions = n.backlinks || [];
      const last = mentions.map(m => m.from.meta.h).filter(Boolean).sort().pop() || n.meta.h;
      return { n, mentions, last };
    })
    .sort((a, b) => new Date(b.last || 0) - new Date(a.last || 0));

  root.innerHTML = `<div class="cards-wrap">
    <div class="toolbar"><span class="lbl">ЛЮДИ</span>
      <span style="font-size:10px;color:var(--mid)">${people.length} ${plural(people.length, 'человек', 'человека', 'человек')} · по последнему упоминанию</span>
      <span class="sp"></span><input id="pp-q" placeholder="имя…" spellcheck="false"></div>
    <div class="cards-body"><div class="grid-cards" id="pp-list"></div></div></div>`;

  const draw = (q = '') => {
    $('#pp-list', root).innerHTML = people
      .filter(({ n }) => !q || n.title.toLowerCase().includes(q))
      .map(({ n, mentions, last }) => `<div class="gcard" data-p="${escA(n.path)}">
        <span class="zone-tag" style="color:${n.zoneRef.color};font-size:9px">■ ${zn(n)}</span>
        <div class="nm">${n.title}</div>
        <div class="mt">упоминаний ${mentions.length} · последнее ${fmtAge(last)}<br>${(n.tags || []).slice(0, 4).map(t => '#' + t).join(' ') || 'без тегов'}</div>
        <div class="mt" style="color:var(--mid);margin-top:6px">${mentions.slice(0, 3).map(m => escA(m.from.title)).join(' · ') || 'нигде не упоминается'}</div>
      </div>`).join('') || '<div style="color:var(--dim);font-size:11px;padding:14px">никого с type: person — поставьте тип в заметке человека</div>';
    $('#pp-list', root).querySelectorAll('[data-p]').forEach(r => r.addEventListener('click', () => { location.hash = `#/note/${encodeURIComponent(r.dataset.p)}`; }));
  };
  $('#pp-q', root).addEventListener('input', e => draw(e.target.value.trim().toLowerCase()));
  draw();
}

/* ── быстрая мысль ───────────────────────────────────────── */
export function initCapture() {
  const wrap = $('#capture');
  wrap.innerHTML = `<div class="cap"><div class="hd">БЫСТРАЯ МЫСЛЬ → <b id="cap-path" style="color:var(--amber-l)"></b><span>ESC — ЗАКРЫТЬ</span></div>
    <textarea id="cap-ta" placeholder="записать мысль… (Ctrl+Enter — сохранить)"></textarea>
    <div class="ft"><button class="btn-amber" style="margin:0" id="cap-save">ЗАПИСАТЬ [CTRL+ENTER]</button>
    <button class="btn-line" id="cap-cancel">ОТМЕНА</button><span class="note">в раздел «${DAILY_THOUGHTS}» · файл дня создастся сам</span></div></div>`;
  const ta = $('#cap-ta', wrap);
  // prefill приходит из «поделиться» на телефоне: текст уже набран в другом
  // приложении, и переписывать его руками — ровно та работа, ради отсутствия
  // которой быстрая мысль и существует.
  const open = (prefill = '') => {
    $('#cap-path', wrap).textContent = `${dailyPath()} › ${DAILY_THOUGHTS}`;
    if (prefill) ta.value = prefill;
    wrap.classList.add('open');
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
  };
  // Снять фокус обязательно: пока он в textarea, клавиатура считает, что человек
  // печатает, и хоткеи (N, C, G, K, /) молча перестают работать после закрытия.
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };
  async function save() {
    const text = ta.value.trim(); if (!text) return close();
    const btn = $('#cap-save', wrap); btn.textContent = 'ЗАПИСЫВАЮ…';
    try {
      const { path, mode, queued } = await appendThought(text);
      ta.value = ''; close();
      toast(queued
        ? `НЕТ СВЯЗИ — МЫСЛЬ В ОЧЕРЕДИ, УЙДЁТ В ${path.toUpperCase()} САМА`
        : `МЫСЛЬ ${mode === 'create' ? 'ОТКРЫЛА ДЕНЬ' : 'ЗАПИСАНА'} → ${path.toUpperCase()}`, queued ? 'warn' : '');
    } catch (e) {
      // текст мысли не теряем: окно остаётся открытым с набранным текстом
      toast(`НЕ ЗАПИСАЛОСЬ: ${e.message}`, 'err', 7000);
    } finally { btn.textContent = 'ЗАПИСАТЬ [CTRL+ENTER]'; }
  }
  $('#cap-save', wrap).addEventListener('click', save);
  $('#cap-cancel', wrap).addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    if (e.key === 'Escape') close();
  });
  return { open, close };
}

/* ── новая заметка ───────────────────────────────────────────────────────────
   Заметка создаётся ИЗ ШАБЛОНОВ ВАЛЬТА (`templates/*.md`), а не из своего
   представления о том, как она должна выглядеть: там фронтматтер, разделы и
   связи в том виде, в каком их ждут Obsidian, ночная консолидация и поиск.
   Тип шаблона подсказывает папку, но не диктует её — вальт живой. */
export function initNoteCreator() {
  const wrap = $('#modal');
  const zoneOptions = () => {
    const dirs = new Set(corpus.notes.map(n => n.path.split('/').slice(0, -1).join('/')).filter(Boolean));
    for (const t of TEMPLATES) dirs.add(t.zone);
    return [...dirs].sort((a, b) => a.localeCompare(b, 'ru'));
  };
  const draw = () => {
    wrap.innerHTML = `<div class="cap"><div class="hd">НОВАЯ ЗАМЕТКА → <b id="nn-path" class="path-preview"></b><span>ESC — ЗАКРЫТЬ</span></div>
      <div class="row"><label><span class="lbl">ИМЯ</span><input id="nn-title" placeholder="Как называется" spellcheck="false"></label></div>
      <div class="row">
        <label><span class="lbl">ШАБЛОН</span><select id="nn-tpl">${TEMPLATES.map((t, i) => `<option value="${i}">${t.label}</option>`).join('')}<option value="-1">БЕЗ ШАБЛОНА</option></select></label>
        <label><span class="lbl">СОЗВЕЗДИЕ (ПАПКА)</span><select id="nn-zone">${zoneOptions().map(z => `<option value="${escA(z)}">${escA(z)}</option>`).join('')}</select></label>
      </div>
      <div class="row"><label><span class="lbl">ОПИСАНИЕ (В ФРОНТМАТТЕР, НЕОБЯЗАТЕЛЬНО)</span><input id="nn-desc" placeholder="одной строкой — о чём заметка" spellcheck="false"></label></div>
      <textarea id="nn-body" placeholder="первый текст заметки… (необязательно)" style="min-height:90px"></textarea>
      <div class="ft"><button class="btn-amber" style="margin:0" id="nn-save">СОЗДАТЬ [CTRL+ENTER]</button>
      <button class="btn-line" id="nn-cancel">ОТМЕНА</button><span class="note">vault_create · существующий файл не тронется</span></div></div>`;
  };
  draw();

  const sync = () => {
    const t = $('#nn-title', wrap).value.trim();
    const zone = $('#nn-zone', wrap).value;
    $('#nn-path', wrap).textContent = t ? `${zone}/${safeFileName(t)}.md` : `${zone}/…`;
  };
  const open = () => {
    draw(); wire();
    // папка по умолчанию — та, что подразумевает выбранный шаблон, а не первая
    // по алфавиту (иначе новая заметка норовит уехать в очередь заданий)
    $('#nn-zone', wrap).value = TEMPLATES[0].zone;
    sync();
    wrap.classList.add('open');
    setTimeout(() => $('#nn-title', wrap).focus(), 30);
  };
  const close = () => { wrap.classList.remove('open'); document.activeElement?.blur(); };

  async function save() {
    const title = $('#nn-title', wrap).value.trim();
    if (!title) return toast('НУЖНО ИМЯ ЗАМЕТКИ', 'warn');
    const ti = +$('#nn-tpl', wrap).value;
    const btn = $('#nn-save', wrap); btn.textContent = 'СОЗДАЮ…';
    try {
      const { path, queued } = await createNote({
        title,
        zone: $('#nn-zone', wrap).value,
        template: ti >= 0 ? TEMPLATES[ti].file : null,
        description: $('#nn-desc', wrap).value.trim(),
        body: $('#nn-body', wrap).value,
      });
      close();
      if (queued) return toast(`НЕТ СВЯЗИ — ЗАМЕТКА ${path.toUpperCase()} В ОЧЕРЕДИ, СОЗДАМ САМ`, 'warn', 6000);
      toast(`СОЗДАНА ${path.toUpperCase()} · ПОЯВИТСЯ НА КАРТЕ ПОСЛЕ ПЕРЕСБОРКИ ИНДЕКСА`, '', 6000);
      location.hash = `#/note/${encodeURIComponent(path)}`;
    } catch (e) {
      toast(`НЕ СОЗДАЛОСЬ: ${e.message}`, 'err', 7000);
    } finally { btn.textContent = 'СОЗДАТЬ [CTRL+ENTER]'; }
  }

  function wire() {
    $('#nn-title', wrap).addEventListener('input', sync);
    $('#nn-zone', wrap).addEventListener('change', sync);
    $('#nn-tpl', wrap).addEventListener('change', () => {
      const ti = +$('#nn-tpl', wrap).value;
      if (ti >= 0) { $('#nn-zone', wrap).value = TEMPLATES[ti].zone; sync(); }
    });
    $('#nn-save', wrap).addEventListener('click', save);
    $('#nn-cancel', wrap).addEventListener('click', close);
    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
  }
  wire();
  return { open, close };
}
