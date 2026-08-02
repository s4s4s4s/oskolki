/**
 * Экраны работы с памятью: разбор, лента, люди, архив.
 *
 * Выделены из views.js, который дорос до двух тысяч строк и перестал быть
 * «экранами». Этот блок уходит первым, потому что он самый самостоятельный:
 * четыре экрана, одно состояние на весь модуль и никаких связей с графом,
 * картотекой и поиском.
 *
 * Общее у них одно — они работают не с отдельной заметкой, а с состоянием
 * памяти целиком: что не разобрано, что когда происходило, кто есть кто и чем
 * подтверждается написанное.
 */
import { corpus, isVisible } from '../corpus.js';
import { textOf } from '../corpus.js';
import { splitFrontmatter, renderMd, fmtAge, fmtBytes, plural } from '../md.js';
import { similarTo } from '../similar.js';
import { toggleTag, linkTo, safeFileName } from '../write.js';
import { tools } from '../api.js';
import { $, el, escA, zn, zoneDot, toast } from '../ui.js';
import { askTag } from '../views.js';

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

/* ── архив ───────────────────────────────────────────────────────────────────
   Улики и вложения. Это не карта знания, а её доказательная база: сюда ходят,
   когда надо проверить утверждение по первоисточнику или достать скан.

   Файлы кладутся перетаскиванием и отдаются подписанной ссылкой, которая живёт
   сутки. Содержимое в приложение не тянется: полтора мегабайта PDF ради строчки
   в списке — плохой обмен, а ссылка открывается тем, что для этого и сделано, —
   браузером. */
const ARCHIVE_DIR = 'archive/файлы';

export async function renderArchive(root) {
  const улики = corpus.notes
    .filter(n => n.klass === 'улика')
    .sort((a, b) => new Date(b.meta.h || 0) - new Date(a.meta.h || 0));
  const разобрано = new Set();
  for (const n of corpus.notes) {
    if (n.klass !== 'утверждение' && n.klass !== 'событие') continue;
    for (const l of n.links || []) if (l.type === 'source') разобрано.add(l.to);
  }

  root.innerHTML = `<div class="cards-wrap">
    <div class="toolbar"><span class="lbl">АРХИВ</span>
      <span style="font-size:10px;color:var(--mid)">${улики.length} ${plural(улики.length, 'улика', 'улики', 'улик')} · разобрано ${разобрано.size} · вложения в ${ARCHIVE_DIR}</span>
      <span class="sp"></span>
      <button class="chip" id="ar-add">＋ ФАЙЛ</button>
      <input id="ar-file" type="file" hidden multiple>
      <input id="ar-q" placeholder="фильтр…" spellcheck="false"></div>
    <div class="cards-body" id="ar-body"><div class="ar-drop" id="ar-drop">
      перетащи сюда PDF, скан или картинку — уйдёт в <b>${ARCHIVE_DIR}</b></div>
      <div id="ar-files"></div><div id="ar-list"></div></div></div>`;

  const list = $('#ar-list', root);
  const draw = (q = '') => {
    const выборка = улики.filter(n => !q || n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q));
    list.innerHTML = `<div class="tl-hd" style="margin-top:16px">УЛИКИ<span>${выборка.length}</span></div>
      <div class="rail-rows">${выборка.slice(0, 300).map(n => `<div data-p="${escA(n.path)}">
        ${zoneDot(n.zoneRef)}<span class="nm">${n.title}</span>
        <span class="zn">${разобрано.has(n) ? 'разобрано' : '—'} · ${fmtBytes(n.meta.b || 0)} · ${fmtAge(n.meta.h)}</span></div>`).join('')}</div>`;
    list.querySelectorAll('[data-p]').forEach(r => r.addEventListener('click', () => {
      location.hash = `#/note/${encodeURIComponent(r.dataset.p)}`;
    }));
  };
  $('#ar-q', root).addEventListener('input', e => draw(e.target.value.trim().toLowerCase()));
  draw();

  // Список уже лежащих вложений: отдельным вызовом, потому что в карту они не
  // попадают — это не заметки, и индексировать их нечем.
  const files = $('#ar-files', root);
  try {
    const текст = await tools.list(ARCHIVE_DIR);
    const строки = текст.split('\n').filter(l => l && !/^\[папка\]/.test(l));
    files.innerHTML = строки.length
      ? `<div class="tl-hd" style="margin-top:14px">ВЛОЖЕНИЯ<span>${строки.length}</span></div>
         <div class="rail-rows">${строки.map(l => {
           const p = l.replace(/\s*\(\d+ б\)$/, '');
           const kb = (l.match(/\((\d+) б\)/) || [])[1];
           return `<div data-f="${escA(p)}"><span class="nm">${escA(p.split('/').pop())}</span>
             <span class="zn">${kb ? fmtBytes(+kb) : ''} · ССЫЛКА</span></div>`;
         }).join('')}</div>`
      : '';
    files.querySelectorAll('[data-f]').forEach(r => r.addEventListener('click', () => shareFile(r.dataset.f)));
  } catch { files.innerHTML = ''; }

  const upload = async fileList => {
    for (const file of fileList) {
      if (file.size > 20 * 1024 * 1024) { toast(`${file.name}: больше 20 МБ — GitHub такой не примет`, 'err', 6000); continue; }
      toast(`ЗАГРУЖАЮ ${file.name.toUpperCase()}…`);
      try {
        const b64 = await new Promise((ok, no) => {
          const fr = new FileReader();
          fr.onload = () => ok(String(fr.result).split(',')[1]);
          fr.onerror = () => no(new Error('файл не прочитался'));
          fr.readAsDataURL(file);
        });
        const res = await tools.upload(`${ARCHIVE_DIR}/${safeFileName(file.name)}`, b64, `архив: ${file.name}`);
        toast(res.toUpperCase().slice(0, 80));
      } catch (e) { toast(`${file.name}: ${e.message}`, 'err', 7000); }
    }
    renderArchive(root);
  };

  const drop = $('#ar-drop', root);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => upload(e.dataTransfer.files));
  $('#ar-add', root).addEventListener('click', () => $('#ar-file', root).click());
  $('#ar-file', root).addEventListener('change', e => upload(e.target.files));
}

// Ссылка на файл: одна кнопка, потому что именно это просят — «скинь мне тот
// PDF». Копируется в буфер и открывается; живёт сутки и потом протухает сама.
async function shareFile(path) {
  toast('ГОТОВЛЮ ССЫЛКУ…');
  try {
    const ответ = await tools.fileLink(path, 24);
    const url = ответ.split('\n')[0].trim();
    await navigator.clipboard.writeText(url).catch(() => {});
    window.open(url, '_blank', 'noopener');
    toast('ССЫЛКА В БУФЕРЕ · ЖИВЁТ СУТКИ', '', 6000);
  } catch (e) { toast(`НЕ ВЫШЛО: ${e.message}`, 'err', 7000); }
}
