// Офлайн-оболочка приложения.
//
// Установленное приложение обязано открываться без сети СРАЗУ — человек ставит
// иконку на экран и ждёт, что она работает в метро. Поэтому оболочка кладётся в
// кэш на install, а не постепенно, по мере того как файлы понадобятся: иначе
// первый же офлайн-запуск после установки упирается в пустой кэш.
//
// Дальше network-first: свежий деплой подхватывается сам, а кэш остаётся
// запасным аэродромом. Данные (индекс, заметки) сюда не попадают — они живут в
// IndexedDB и ходят своим путём через воркер.
const CACHE = 'shards-shell-v2';

const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css', './css/fonts.css',
  './js/main.js', './js/views.js', './js/graph.js', './js/corpus.js',
  './js/search.js', './js/api.js', './js/store.js', './js/write.js',
  './js/ai.js', './js/diff.js', './js/md.js', './js/config.js', './js/demo.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable.png',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll падает целиком, если хоть один файл недоступен — кладём по одному,
    // чтобы установка не срывалась из-за единственного промаха.
    await Promise.all(SHELL.map(u => cache.add(u).catch(() => {})));
    // Шрифты весят 400 КБ и нужны, чтобы приложение не «прыгало» офлайн;
    // тянем их следом, уже не блокируя установку.
    await cachePermanentFonts(cache);
    self.skipWaiting();
  })());
});

// Пути шрифтов сгенерированы, поэтому вытаскиваем их из самого fonts.css.
async function cachePermanentFonts(cache) {
  try {
    const css = await (await fetch('./css/fonts.css')).text();
    const urls = [...css.matchAll(/url\((\.\.\/fonts\/[^)]+)\)/g)].map(m => './' + m[1].replace('../', ''));
    await Promise.all([...new Set(urls)].map(u => cache.add(u).catch(() => {})));
  } catch {}
}

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Шрифты теперь свои, поэтому чужие домены не трогаем вовсе: всё, что нужно
  // офлайн, лежит на этом же origin. API и WebSocket идут мимо кэша.
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      // Запуск с ярлыка или из «поделиться» приходит с query — навигацию всегда
      // разруливаем оболочкой, иначе установленное приложение офлайн покажет
      // ошибку вместо карты.
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html') || await cache.match('./');
        if (shell) return shell;
      }
      return new Response('офлайн', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
