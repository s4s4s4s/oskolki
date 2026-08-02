// Граф на canvas 2D: раскладки (зоны/силовая/свежесть), кодировка цветом и
// размером, фильтры, пан/зум, наведение, выбор, клавиатура.
// 3D-режим — задел для three.js (см. README).
import { ageHours } from './md.js';

const lerp = (a, b, t) => a + (b - a) * t;
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function mix(h1, h2, t) { const a = hexToRgb(h1), b = hexToRgb(h2); return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`; }

export class GraphView {
  constructor(canvas, model, cb) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.cb = cb; // {onHover(note|null,x,y), onSelect(note|null), onOpen(note)}
    this.layout = 'zones'; this.colorBy = 'zone'; this.sizeBy = 'bytes';
    this.filterText = ''; this.selected = null; this.hovered = null;
    this.cam = { x: 0, y: 0, k: 1 };
    this.running = false;
    this._userMoved = false;
    this._sprites = new Map();
    this.setModel(model);
    this._bind();
    this._dust = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), s: Math.random() < .75 ? 1 : 2, o: .1 + Math.random() * .28 }));
  }

  setModel(model) {
    this.model = model;
    const old = new Map((this.nodes || []).map(n => [n.note.path, n]));
    this.nodes = model.notes.map(note => {
      const prev = old.get(note.path);
      return { note, x: prev ? prev.x : (Math.random() - .5) * 800, y: prev ? prev.y : (Math.random() - .5) * 800, vx: 0, vy: 0, r: 5, alpha: 1 };
    });
    const idx = new Map(this.nodes.map(n => [n.note, n]));
    this.links = model.edges.map(e => ({ a: idx.get(e.a), b: idx.get(e.b) })).filter(l => l.a && l.b);
    this.selected = this.selected && idx.get(this.selected.note) || null;
    this._applyAnchors(); this._applyStyle(); this.heat(1);
  }

  // Секторы созвездий: угловая доля пропорциональна КОРНЮ числа заметок.
  // Поровну нельзя — созвездия вальта различаются на порядок (ЛЮДИ 58 против
  // СФЕР 2), при равных долях крупные наползают на соседей, а мелкие болтаются
  // в пустоте. Корень, а не доля: линейно самое крупное съело бы полкруга.
  _sectors() {
    const zones = this.model.zones;
    const w = zones.map(z => Math.sqrt(Math.max(z.count, 1)));
    const total = w.reduce((a, b) => a + b, 0) || 1;
    const map = new Map();
    let acc = 0;
    zones.forEach((z, i) => {
      const span = (w[i] / total) * Math.PI * 2;
      map.set(z.name, { angle: acc + span / 2 - Math.PI / 2, span, zone: z });
      acc += span;
    });
    return map;
  }

  // ── раскладки: каждой ноде цель-якорь ────────────────────
  _applyAnchors() {
    const N = this.nodes; if (!N.length) return;
    const sectors = this._sectors();
    if (this.layout === 'zones') {
      const R = 150 + N.length * 1.35;
      for (const { angle, zone } of sectors.values()) {
        zone._ax = Math.cos(angle) * R; zone._ay = Math.sin(angle) * R * .72;
      }
      for (const n of N) { n.ax = n.note.zoneRef._ax; n.ay = n.note.zoneRef._ay; n.pull = .02; }
    } else if (this.layout === 'fresh') {
      for (const n of N) {
        const age = Math.min(ageHours(n.note.meta.h) + 1, 24 * 400);
        const r = 60 + Math.log10(age + 1) / Math.log10(24 * 400) * 380;
        const s = sectors.get(n.note.zone);
        const a = s.angle + (hash(n.note.path) - .5) * s.span * .8;
        n.ax = Math.cos(a) * r; n.ay = Math.sin(a) * r * .8; n.pull = .03;
      }
    } else { for (const n of N) { n.ax = 0; n.ay = 0; n.pull = .0022; } }
  }

  _applyStyle() {
    const bs = this.model.notes.map(n => n.meta.b);
    const maxB = Math.max(...bs, 1), maxD = Math.max(...this.model.notes.map(n => n.deg), 1), maxC = Math.max(...this.model.notes.map(n => n.meta.c), 1);
    for (const n of this.nodes) {
      const m = n.note.meta;
      const v = this.sizeBy === 'deg' ? n.note.deg / maxD : this.sizeBy === 'commits' ? m.c / maxC : Math.sqrt(m.b / maxB);
      n.r = 3 + v * 7;
      if (this.colorBy === 'fresh') {
        const t = 1 - Math.min(Math.log10(ageHours(m.h) + 1) / Math.log10(24 * 400), 1);
        n.color = mix('#48506a', '#f0a860', t);
      } else if (this.colorBy === 'deg') {
        n.color = mix('#48506a', '#57d9c9', Math.min(n.note.deg / maxD, 1));
      } else n.color = n.note.zoneRef.color;
      n.rot = this.model.zones.indexOf(n.note.zoneRef) % 2 ? Math.PI / 4 : 0;
    }
    const ranked = [...this.nodes].sort((a, b) => b.note.deg - a.note.deg);
    ranked.forEach((n, i) => { n.tier = i < 10 ? 1 : i < 30 ? 2 : 3; });
    this._applyFilter();
  }

  _applyFilter() {
    const q = this.filterText.trim().toLowerCase();
    for (const n of this.nodes) {
      const zoneOn = n.note.zoneRef.on;
      const txtOk = !q || n.note.title.toLowerCase().includes(q) || n.note.path.toLowerCase().includes(q);
      n.dim = !(zoneOn && txtOk);
    }
  }

  set(opts) { Object.assign(this, opts); this._applyAnchors(); this._applyStyle(); this._userMoved = false; this.heat(1); }
  refreshFilter() { this._applyFilter(); }

  heat(h) { this._heat = Math.max(this._heat || 0, h); }

  // ── физика ───────────────────────────────────────────────
  _tick() {
    const N = this.nodes; const heat = this._heat;
    if (heat < .003) return;
    this._heat *= .985;
    const rep = 1800, spring = .02, len = 72;
    for (let i = 0; i < N.length; i++) {
      const a = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const b = N[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy; if (d2 < 1) { d2 = 1; dx = Math.random() - .5; dy = Math.random() - .5; }
        if (d2 > 160000) continue;
        const f = rep / d2 * heat;
        const d = Math.sqrt(d2); dx /= d; dy /= d;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
    }
    for (const l of this.links) {
      const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - len) * spring * heat / d;
      l.a.vx += dx * f; l.a.vy += dy * f; l.b.vx -= dx * f; l.b.vy -= dy * f;
    }
    for (const n of N) {
      n.vx += (n.ax - n.x) * n.pull * heat * 3; n.vy += (n.ay - n.y) * n.pull * heat * 3;
      n.vx *= .86; n.vy *= .86; n.x += n.vx; n.y += n.vy;
    }
    if (!this._userMoved) this.fit();
  }

  // вписать граф в окно (пока пользователь сам не двигал камеру)
  fit(margin = 70) {
    const vis = this.nodes.filter(n => !n.dim);
    if (!vis.length || !this._dpr) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const n of vis) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
    const w = this.canvas.width / this._dpr, h = this.canvas.height / this._dpr;
    const k2 = Math.max(.25, Math.min(1, Math.min((w - margin * 2) / (x1 - x0 + 1), (h - margin * 2) / (y1 - y0 + 1))));
    this._fitK = k2;
    this.cam.k = k2; this.cam.x = -(x0 + x1) / 2 * k2; this.cam.y = -(y0 + y1) / 2 * k2;
  }

  // ── рендер ───────────────────────────────────────────────
  _render() {
    const { ctx, canvas, cam } = this;
    const W = canvas.width, H = canvas.height, dpr = this._dpr;
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.scale(dpr, dpr);
    const w = W / dpr, h = H / dpr;
    for (const d of this._dust) { ctx.globalAlpha = d.o; ctx.fillStyle = '#cdd3ea'; ctx.fillRect(d.x * w, d.y * h, d.s, d.s); }
    ctx.globalAlpha = 1;
    ctx.translate(w / 2 + cam.x, h / 2 + cam.y); ctx.scale(cam.k, cam.k);

    const sel = this.selected, hov = this.hovered;
    const nb = sel ? new Set([sel, ...this.links.filter(l => l.a === sel || l.b === sel).flatMap(l => [l.a, l.b])]) : null;
    ctx.lineWidth = 1 / cam.k;
    for (const l of this.links) {
      const hl = (sel && (l.a === sel || l.b === sel)) || (hov && (l.a === hov || l.b === hov));
      const dim = l.a.dim || l.b.dim;
      ctx.strokeStyle = hl ? 'rgba(240,168,96,.85)' : dim ? 'rgba(74,84,112,.08)' : 'rgba(74,84,112,.5)';
      ctx.lineWidth = (hl ? 1.4 : 1) / cam.k;
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke();
    }
    const rr = (x, y, s, rad) => { ctx.beginPath(); ctx.roundRect(x, y, s, s, rad); ctx.fill(); };
    for (const n of this.nodes) {
      const faded = (n.dim || (nb && !nb.has(n))) && n !== hov;
      const isSel = n === sel, isHov = n === hov;
      ctx.save(); ctx.translate(n.x, n.y); ctx.rotate(n.rot || 0);
      const rad = Math.min(2.2, n.r * .4);
      if (faded) {
        ctx.globalAlpha = .12; ctx.fillStyle = n.color;
        rr(-n.r, -n.r, n.r * 2, rad);
      } else {
        // спрайт с настоящим blur — точная копия box-shadow из макета 2a
        const s = this._sprite(isSel ? '#f0a860' : n.color, n.r, isSel);
        ctx.drawImage(s.c, -s.size / 2, -s.size / 2, s.size, s.size);
        if (isSel || isHov) {
          // тёмный зазор + янтарное кольцо
          const g1 = 1.6 / cam.k, g2 = 3.4 / cam.k;
          ctx.strokeStyle = '#131519'; ctx.lineWidth = 3.2 / cam.k;
          ctx.beginPath(); ctx.roundRect(-n.r - g1, -n.r - g1, (n.r + g1) * 2, (n.r + g1) * 2, rad + g1); ctx.stroke();
          ctx.strokeStyle = '#f0a860'; ctx.lineWidth = 1.6 / cam.k;
          ctx.beginPath(); ctx.roundRect(-n.r - g2, -n.r - g2, (n.r + g2) * 2, (n.r + g2) * 2, rad + g2); ctx.stroke();
        }
      }
      ctx.restore(); ctx.globalAlpha = 1;
    }
    ctx.restore();
    // ── семантический зум подписей ──────────────────────
    // далеко — только имена созвездий (зон); ближе — хабы; вплотную — все
    ctx.save(); ctx.scale(dpr, dpr);
    const k = cam.k;
    const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const taken = [];
    const solids = [];
    for (const n of this.nodes) {
      if (n.dim || (nb && !nb.has(n) && n !== hov)) continue;
      const p = this._toScreen(n.x, n.y), rk = n.r * k * 2.2 + 2;
      solids.push({ n, x: p.x - rk, y: p.y - rk, w: rk * 2, h: rk * 2 });
    }
    ctx.lineJoin = 'round';
    const fitK = this._fitK || 1;
    const clash = (rect, own) =>
      taken.some(r => rect.x < r.x + r.w + 6 && rect.x + rect.w > r.x - 6 && rect.y < r.y + r.h + 2 && rect.y + rect.h > r.y - 2) ||
      solids.some(s => s.n !== own && rect.x < s.x + s.w && rect.x + rect.w > s.x && rect.y < s.y + s.h && rect.y + rect.h > s.y);
    // панель «УЗЕЛ // ВЫБРАН» — запретная зона для подписей
    if (sel) taken.push({ x: w - 330, y: 0, w: 330, h: 196 });
    // созвездия видны только когда подписи шардов уже погасли (жёсткое разделение)
    const zoneAlpha = (1 - ss(.62 * fitK, .8 * fitK, k)) * .95;
    if (zoneAlpha > .03 && this.layout !== 'force') {
      ctx.font = '500 12px "IBM Plex Mono",monospace';
      try { ctx.letterSpacing = '5px'; } catch {}
      ctx.textAlign = 'center'; ctx.strokeStyle = 'rgba(19,21,25,.85)'; ctx.lineWidth = 4;
      for (const z of [...this.model.zones].sort((a, b) => b.count - a.count)) {
        if (!z.on) continue;
        let cx = 0, m = 0, top = 1e9;
        for (const n of this.nodes) if (n.note.zoneRef === z && !n.dim) { cx += n.x; m++; if (n.y - n.r < top) top = n.y - n.r; }
        if (!m) continue;
        const p = this._toScreen(cx / m, top);
        const py = p.y - 14;
        if (p.x < -100 || p.x > w + 100 || py < -40 || py > h + 40) continue;
        const name = z.label || z.name.toUpperCase();
        const tw = ctx.measureText(name).width;
        let py2 = py, rect = null;
        for (let t = 0; t < 3; t++) {
          const r2 = { x: p.x - tw / 2 - 4, y: py2 - 12, w: tw + 8, h: 16 };
          if (!clash(r2, null)) { rect = r2; break; }
          py2 -= 17;
        }
        if (!rect) continue;
        ctx.globalAlpha = zoneAlpha;
        ctx.shadowColor = '#131519'; ctx.shadowBlur = 10;
        ctx.fillStyle = z.color;
        ctx.fillText(name, Math.round(p.x), Math.round(py2));
        ctx.fillText(name, Math.round(p.x), Math.round(py2));
        ctx.shadowBlur = 0;
        taken.push(rect);
      }
      ctx.globalAlpha = 1; ctx.textAlign = 'start';
    }
    // подписи узлов — как в макете 2a: 9px mono, разрядка, мягкая тень
    ctx.font = '400 9px "IBM Plex Mono",monospace';
    try { ctx.letterSpacing = '0.45px'; } catch {}
    const hasFilter = !!this.filterText.trim();
    const cands = [];
    for (const n of this.nodes) {
      if (n.dim || (nb && !nb.has(n) && n !== hov)) continue;
      let la = n.tier === 1 ? ss(.86 * fitK, fitK, k) : n.tier === 2 ? ss(1.45 * fitK, 1.65 * fitK, k) : ss(1.9 * fitK, 2.2 * fitK, k);
      if (nb && nb.has(n)) la = 1;
      if (hasFilter) la = Math.max(la, .95);
      if (n === sel || n === hov) la = 1;
      if (la < .05) continue;
      n._la = la; cands.push(n);
    }
    cands.sort((a, b) => {
      const pa = (a === sel || a === hov) ? 0 : (nb && nb.has(a)) ? 1 : 2;
      const pb = (b === sel || b === hov) ? 0 : (nb && nb.has(b)) ? 1 : 2;
      return pa - pb || a.tier - b.tier || b.r - a.r;
    });
    for (const n of cands) {
      const p = this._toScreen(n.x, n.y);
      if (p.x < -40 || p.x > w + 40 || p.y < -20 || p.y > h + 20) continue;
      const rk = n.r * k, tw = ctx.measureText(n.note.title).width;
      const spots = [
        [p.x + rk + 8, p.y + 3.5],
        [p.x - rk - 8 - tw, p.y + 3.5],
        [p.x - tw / 2, p.y + rk + 14],
        [p.x - tw / 2, p.y - rk - 8],
      ];
      const pri = n === sel || n === hov || (nb && nb.has(n));
      let put = null;
      for (const [sx, sy] of spots) {
        const rect = { x: sx, y: sy - 9, w: tw, h: 13 };
        if (rect.x < 4 || rect.x + rect.w > w - 4 || rect.y < 4 || rect.y + rect.h > h - 4) continue;
        if (!clash(rect, n)) { put = { sx, sy, rect }; break; }
      }
      if (!put) { if (pri) put = { sx: spots[0][0], sy: spots[0][1], rect: { x: spots[0][0], y: spots[0][1] - 9, w: tw, h: 13 } }; else continue; }
      taken.push(put.rect);
      const lx = Math.round(put.sx), ly = Math.round(put.sy);
      ctx.globalAlpha = n._la;
      ctx.shadowColor = '#131519'; ctx.shadowBlur = 6;
      ctx.fillStyle = (n === sel || n === hov) ? '#ffdca6' : '#93a0b8';
      ctx.fillText(n.note.title, lx, ly);
      ctx.fillText(n.note.title, lx, ly);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    // перекрестье выбора (в экранных координатах)
    if (sel) {
      const p = this._toScreen(sel.x, sel.y);
      ctx.save(); ctx.scale(dpr, dpr);
      ctx.strokeStyle = 'rgba(240,168,96,.28)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, p.y); ctx.lineTo(w, p.y); ctx.moveTo(p.x, 0); ctx.lineTo(p.x, h); ctx.stroke();
      ctx.restore();
    }
  }

  _toScreen(x, y) { const w = this.canvas.width / this._dpr, h = this.canvas.height / this._dpr; return { x: (x * this.cam.k) + w / 2 + this.cam.x, y: (y * this.cam.k) + h / 2 + this.cam.y }; }

  // спрайт узла: roundRect + настоящий shadowBlur (как box-shadow в макете), кэш по цвету/размеру
  _sprite(color, r, hl) {
    const r2 = Math.max(1.5, Math.round(r * 2) / 2);
    const key = color + '|' + r2 + '|' + (hl ? 1 : 0);
    let s = this._sprites.get(key);
    if (s) return s;
    const blur = hl ? 22 : 4 + r2 * 1.4;
    const pad = Math.ceil(blur * 1.3 + 3);
    const size = Math.ceil(r2 * 2 + pad * 2);
    const c = document.createElement('canvas');
    c.width = c.height = size * 2;
    const x = c.getContext('2d'); x.scale(2, 2);
    x.shadowColor = color + (hl ? 'cc' : '77'); x.shadowBlur = blur;
    x.fillStyle = hl ? '#ffdca6' : color;
    x.beginPath(); x.roundRect(pad, pad, r2 * 2, r2 * 2, Math.min(2.5, r2 * .45));
    x.fill(); x.fill();
    s = { c, size };
    this._sprites.set(key, s);
    return s;
  }
  _toWorld(sx, sy) { const w = this.canvas.width / this._dpr, h = this.canvas.height / this._dpr; return { x: (sx - w / 2 - this.cam.x) / this.cam.k, y: (sy - h / 2 - this.cam.y) / this.cam.k }; }

  _pick(sx, sy) {
    const p = this._toWorld(sx, sy);
    let best = null, bd = 1e9;
    for (const n of this.nodes) {
      if (n.dim) continue;
      const dx = n.x - p.x, dy = n.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < n.r + 6 / this.cam.k && d < bd) { best = n; bd = d; }
    }
    return best;
  }

  // ── события ──────────────────────────────────────────────
  _bind() {
    const c = this.canvas;
    let drag = null, moved = false;
    c.addEventListener('pointerdown', e => { drag = { x: e.offsetX, y: e.offsetY }; moved = false; c.setPointerCapture(e.pointerId); c.classList.add('drag'); });
    c.addEventListener('pointermove', e => {
      if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; this._userMoved = true; }
        this.cam.x += dx; this.cam.y += dy; drag = { x: e.offsetX, y: e.offsetY };
      } else {
        const n = this._pick(e.offsetX, e.offsetY);
        if (n !== this.hovered) { this.hovered = n; this.cb.onHover(n ? n.note : null, e.offsetX, e.offsetY); c.style.cursor = n ? 'pointer' : ''; }
        else if (n) this.cb.onHover(n.note, e.offsetX, e.offsetY);
      }
    });
    c.addEventListener('pointerup', e => {
      c.classList.remove('drag');
      if (drag && !moved) {
        const n = this._pick(e.offsetX, e.offsetY);
        if (n && this.selected === n) this.cb.onOpen(n.note);
        else { this.selected = n; this.cb.onSelect(n ? n.note : null); }
      }
      drag = null;
    });
    c.addEventListener('pointerleave', () => { this.hovered = null; this.cb.onHover(null); });
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this._userMoved = true;
      const k0 = this.cam.k;
      const k = Math.max(.25, Math.min(5, k0 * (e.deltaY < 0 ? 1.12 : .89)));
      const w = this.canvas.width / this._dpr, h = this.canvas.height / this._dpr;
      this.cam.x = e.offsetX - w / 2 - (e.offsetX - w / 2 - this.cam.x) * (k / k0);
      this.cam.y = e.offsetY - h / 2 - (e.offsetY - h / 2 - this.cam.y) * (k / k0);
      this.cam.k = k;
    }, { passive: false });
    c.addEventListener('dblclick', e => { const n = this._pick(e.offsetX, e.offsetY); if (n) this.cb.onOpen(n.note); });
  }

  // клавиатура: стрелки — ближайший узел в направлении, Enter — открыть
  key(e) {
    this._userMoved = true;
    const dirs = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === 'Enter' && this.selected) { this.cb.onOpen(this.selected.note); return true; }
    if (e.key === 'Escape' && this.selected) { this.selected = null; this.cb.onSelect(null); return true; }
    if (e.key === 'Tab') {
      const vis = this.nodes.filter(n => !n.dim); if (!vis.length) return false;
      const i = vis.indexOf(this.selected);
      this.selected = vis[(i + (e.shiftKey ? -1 : 1) + vis.length) % vis.length];
      this._center(this.selected); this.cb.onSelect(this.selected.note); return true;
    }
    const d = dirs[e.key];
    if (!d) return false;
    const vis = this.nodes.filter(n => !n.dim);
    if (!this.selected) { this.selected = vis[0] || null; }
    else {
      let best = null, bs = 1e18;
      for (const n of vis) {
        if (n === this.selected) continue;
        const dx = n.x - this.selected.x, dy = n.y - this.selected.y;
        const dot = dx * d[0] + dy * d[1];
        if (dot <= 0) continue;
        const score = (dx * dx + dy * dy) / (dot * dot / (dx * dx + dy * dy + 1e-6));
        if (score < bs) { bs = score; best = n; }
      }
      if (best) this.selected = best;
    }
    if (this.selected) { this._center(this.selected); this.cb.onSelect(this.selected.note); }
    return true;
  }
  _center(n) {
    const p = this._toScreen(n.x, n.y);
    const w = this.canvas.width / this._dpr, h = this.canvas.height / this._dpr;
    if (p.x < 60 || p.x > w - 60 || p.y < 60 || p.y > h - 60) { this.cam.x = -n.x * this.cam.k; this.cam.y = -n.y * this.cam.k; }
  }

  centerOn(note) { const n = this.nodes.find(n => n.note === note); if (n) { this.selected = n; this.cam.x = -n.x * this.cam.k; this.cam.y = -n.y * this.cam.k; } }

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this._dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, r.width * this._dpr);
    this.canvas.height = Math.max(1, r.height * this._dpr);
    this.canvas.style.width = r.width + 'px'; this.canvas.style.height = r.height + 'px';
  }

  start() {
    if (this.running) return;
    this.running = true; this.resize(); this.heat(1);
    const loop = () => { if (!this.running) return; this._tick(); this._render(); this._raf = requestAnimationFrame(loop); };
    loop();
  }
  stop() { this.running = false; cancelAnimationFrame(this._raf); }
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return ((h >>> 0) % 1000) / 1000; }
