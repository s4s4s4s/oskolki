/**
 * Общие примитивы интерфейса.
 *
 * Выделены из `views.js`, который дорос до двух с лишним тысяч строк и стал не
 * «экранами», а «всем остальным». Резать его целиком одним движением рискованно,
 * поэтому первым выходит фундамент: то, чем пользуются все экраны без исключения.
 * Пока эти функции жили внутри общего файла, ни один экран нельзя было вынести —
 * он тянул за собой весь файл.
 *
 * Здесь только то, что не знает ни про один конкретный экран.
 */
import { resolveWiki } from './corpus.js';

export const $ = (sel, el = document) => el.querySelector(sel);
export const el = (tag, cls, html) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
};

// Экранирование для подстановки в атрибуты и текст разметки.
export const escA = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Сравнение имён: «Алёна» и «Алена» — одно и то же, регистр не важен.
export const norm2 = s => String(s).toLowerCase().replace(/ё/g, 'е').trim();

// Подпись созвездия: человеческое имя из словаря, а не путь папки.
export const zn = note => note?.zoneRef?.label || (note?.zone || '').toUpperCase();

export const zoneDot = z => `<span class="dot glow" style="background:${z.color};color:${z.color}"></span>`;

export const noteHref = n => `#/note/${encodeURIComponent(n.path)}`;
export const openNote = n => { location.hash = noteHref(n); };

export function toast(msg, kind = '', ms = 4200) {
  const t = el('div', `toast ${kind}`, `<i></i><span>${msg}</span>`);
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity .3s';
    setTimeout(() => t.remove(), 350);
  }, ms);
}

/* Ссылка [[вида wikilink]] в отрисованном тексте. Если цели нет — не молчим:
   помечаем битой и уводим в поиск по имени. Битая ссылка это рабочий сигнал
   «такую заметку надо завести», а не ошибка отображения. */
export function wireWikiLinks(root) {
  root.querySelectorAll('a.wiki').forEach(a => {
    const t = resolveWiki(a.dataset.wiki);
    if (!t) { a.classList.add('broken'); a.title = 'заметка не найдена'; }
    a.addEventListener('click', () => t
      ? openNote(t)
      : toast(`нет заметки «${a.dataset.wiki}» — ищу…`, 'warn')
        || (location.hash = `#/search?q=${encodeURIComponent(a.dataset.wiki)}`));
  });
}

/* Дифф в разметку. Один вид на два случая: конфликт правки и просмотр версии из
   истории. «−» — то, что было, «+» — то, что стало. */
export const diffHtml = parts => `<div class="diff">${parts.map(p =>
  `<div class="dl ${p.type}">${p.text.split('\n').map(l =>
    `<span>${(p.type === 'add' ? '+ ' : p.type === 'del' ? '− ' : p.type === 'skip' ? '' : '  ') + l}</span>`).join('')}</div>`).join('')}</div>`;
