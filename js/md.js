// Маркдаун: фронтматтер, разделы по заголовкам, простой рендер, wikilinks.
export function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { fm: m[1], body: raw.slice(m[0].length) } : { fm: null, body: raw };
}

// разделы: интро (до первого заголовка) + по одному на каждый заголовок
export function parseSections(body) {
  const out = [];
  const re = /^(#{1,4}) (.+)$/gm;
  let last = { heading: null, level: 0, start: 0 };
  let m;
  const push = end => { const text = body.slice(last.start, end); if (text.trim() || last.heading) out.push({ ...last, body: text.replace(/^#{1,4} .+\n?/, '') }); };
  while ((m = re.exec(body))) { push(m.index); last = { heading: m[2].trim(), level: m[1].length, start: m.index }; }
  push(body.length);
  return out;
}

export const WIKI_RE = /\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g;
export const linksOf = text => { const out = []; let m; WIKI_RE.lastIndex = 0; while ((m = WIKI_RE.exec(text))) out.push({ target: m[1].trim(), heading: m[2] || null, alias: m[3] || null }); return out; };

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  s = esc(s);
  s = s.replace(/!?\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g, (_, t, h, a) =>
    `<a class="wiki" data-wiki="${t.trim()}"${h ? ` data-heading="${h}"` : ''}>${a || t.trim()}</a>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

export function renderMd(src) {
  const lines = src.split('\n');
  let html = '', list = null, para = [], code = false, codeBuf = [];
  const flushP = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const flushL = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const ln of lines) {
    if (code) { if (/^```/.test(ln)) { html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`; code = false; codeBuf = []; } else codeBuf.push(ln); continue; }
    if (/^```/.test(ln)) { flushP(); flushL(); code = true; continue; }
    const h = ln.match(/^(#{1,4}) (.+)/);
    if (h) { flushP(); flushL(); html += `<div class="md-h${h[1].length}"><strong>${inline(h[2])}</strong></div>`; continue; }
    const li = ln.match(/^\s*[-*] (?:\[([ x])\] )?(.+)/);
    const oli = ln.match(/^\s*\d+\. (.+)/);
    if (li) { flushP(); if (list !== 'ul') { flushL(); html += '<ul>'; list = 'ul'; }
      html += `<li>${li[1] ? (li[1] === 'x' ? '☑ ' : '☐ ') : ''}${inline(li[2])}</li>`; continue; }
    if (oli) { flushP(); if (list !== 'ol') { flushL(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(oli[1])}</li>`; continue; }
    if (/^> ?/.test(ln)) { flushP(); flushL(); html += `<blockquote>${inline(ln.replace(/^> ?/, ''))}</blockquote>`; continue; }
    if (/^(---|\*\*\*)\s*$/.test(ln)) { flushP(); flushL(); html += '<hr>'; continue; }
    if (!ln.trim()) { flushP(); flushL(); continue; }
    para.push(ln.trim());
  }
  if (code) html += `<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`;
  flushP(); flushL();
  return html;
}

// человеческие форматы
export const fmtBytes = b => b < 1024 ? `${b} Б` : b < 1048576 ? `${(b / 1024).toFixed(1).replace('.', ',')} КБ` : `${(b / 1048576).toFixed(1).replace('.', ',')} МБ`;
export function fmtAge(isoStr) {
  if (!isoStr) return '—';
  const s = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (s < 90) return 'только что';
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  if (s < 86400 * 2) return 'вчера';
  return `${Math.round(s / 86400)} дн назад`;
}
export const ageHours = isoStr => isoStr ? (Date.now() - new Date(isoStr).getTime()) / 36e5 : 1e5;
export const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
