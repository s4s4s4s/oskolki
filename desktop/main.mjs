/**
 * Десктопное приложение «Осколки».
 *
 * Тот же интерфейс, что в вебе, но с тем, чего браузер дать не может:
 *   • вальт читается и пишется прямо с диска — без сети, без воркера, без секрета;
 *   • глобальный хоткей Ctrl+Shift+M ловит мысль из любого приложения;
 *   • иконка в трее: окно закрывается, приложение остаётся под рукой;
 *   • изменения файлов вальта прилетают в интерфейс сразу (свой «живой канал»);
 *   • запросы к Anthropic идут из главного процесса, минуя CORS браузера.
 *
 * Интерфейс грузится по схеме app://, а не file:// — иначе Chromium блокирует
 * ES-модули на пустом origin, и приложение не стартует вовсе.
 */
import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell, protocol, net, nativeImage } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { VaultFs, looksLikeVault } from './vault-fs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');                    // корень с index.html
const SETTINGS = () => join(app.getPath('userData'), 'settings.json');

let win = null, tray = null, vault = null, watcher = null;
let settings = { vaultPath: '', closeToTray: true };

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

/* ── настройки ────────────────────────────────────────────────────────────── */

async function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(await readFile(SETTINGS(), 'utf8')) }; } catch {}
  // Путь можно задать снаружи: так проверяется сборка и так удобно держать
  // несколько вальтов, не трогая сохранённые настройки.
  if (process.env.SHARDS_VAULT) settings.vaultPath = process.env.SHARDS_VAULT;
  if (settings.vaultPath && await looksLikeVault(settings.vaultPath)) vault = new VaultFs(settings.vaultPath);
}
async function saveSettings() {
  await mkdir(dirname(SETTINGS()), { recursive: true });
  await writeFile(SETTINGS(), JSON.stringify(settings, null, 2), 'utf8');
}

/* ── слежение за вальтом: свой живой канал ────────────────────────────────── */

function watchVault() {
  watcher?.close();
  if (!settings.vaultPath) return;
  let pending = new Set(), timer = null;
  try {
    watcher = watch(settings.vaultPath, { recursive: true }, (_, file) => {
      if (!file) return;
      const p = file.split(sep).join('/');
      if (p.startsWith('.git/') || p.includes('/.git/') || !/\.(md|json)$/i.test(p)) return;
      pending.add(p);
      clearTimeout(timer);
      // Один git pull трогает сотни файлов — шлём одним событием, иначе
      // интерфейс перечитывает корпус десятки раз подряд.
      timer = setTimeout(() => {
        const paths = [...pending]; pending = new Set();
        vault && (vault._index = null);
        win?.webContents.send('vault:changed', {
          paths,
          indexTouched: paths.some(x => x.startsWith('_машина/индекс')),
        });
      }, 500);
    });
  } catch {}
}

/* ── окно ─────────────────────────────────────────────────────────────────── */

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600,
    backgroundColor: '#131519',
    show: false,
    // Своя титульная полоса: у приложения уже есть верхняя полоса на 34px,
    // вторая сверху выглядела бы как окно браузера, а не как приложение.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#131519', symbolColor: '#8b93ad', height: 34 },
    icon: join(ROOT, 'icons', 'icon-512.png'),
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // Показываем по факту загрузки, а не по ready-to-show: с кастомной титульной
  // полосой это событие может не прийти вовсе, и приложение остаётся живым
  // процессом без единого окна — снаружи выглядит как «не запустилось».
  const reveal = () => { if (win && !win.isVisible()) win.show(); };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 3000);            // последний рубеж: лучше пустое окно, чем ничего
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('не загрузилось:', code, desc, url);
    reveal();
  });
  win.loadURL('app://oskolki/index.html');

  // Внешние ссылки — в системный браузер, а не внутрь приложения.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); }
  });

  win.on('close', e => {
    if (settings.closeToTray && !app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

const showWindow = () => {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
};
const captureThought = () => { showWindow(); win.webContents.send('shards:capture'); };

/* ── трей ─────────────────────────────────────────────────────────────────── */

function createTray() {
  const icon = nativeImage.createFromPath(join(ROOT, 'icons', 'icon-192.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Осколки — карта памяти');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть карту', click: showWindow },
    { label: 'Быстрая мысль\tCtrl+Shift+M', click: captureThought },
    { label: 'Спросить память', click: () => { showWindow(); win.webContents.send('shards:route', '#/ask'); } },
    { type: 'separator' },
    { label: 'Выбрать вальт…', click: pickVault },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showWindow);
}

/* ── выбор папки вальта ───────────────────────────────────────────────────── */

async function pickVault() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Где лежит вальт',
    properties: ['openDirectory'],
    defaultPath: settings.vaultPath || app.getPath('documents'),
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const root = res.filePaths[0];
  if (!await looksLikeVault(root)) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Это не похоже на вальт',
      detail: 'В выбранной папке нет ни «_машина/индекс», ни «daily». Выберите корень репозитория с заметками.',
    });
    return null;
  }
  settings.vaultPath = root;
  vault = new VaultFs(root);
  await saveSettings();
  watchVault();
  win?.webContents.send('vault:picked', root);
  return root;
}

/* ── мост в интерфейс ─────────────────────────────────────────────────────── */

ipcMain.handle('vault:state', () => ({ path: settings.vaultPath, ready: !!vault }));
ipcMain.handle('vault:pick', () => pickVault());
ipcMain.handle('vault:call', async (_e, name, args) => {
  if (!vault) return { isError: true, text: 'вальт не выбран' };
  try { return { isError: false, text: await vault.call(name, args) }; }
  catch (e) { return { isError: true, text: e.message }; }
});
ipcMain.handle('vault:reveal', (_e, p) => {
  if (!settings.vaultPath) return;
  shell.showItemInFolder(join(settings.vaultPath, ...String(p).split('/')));
});

// Запрос к Anthropic идёт отсюда: у главного процесса нет CORS, поэтому ключ
// работает без браузерных послаблений, а стрим уходит в интерфейс кусками.
ipcMain.handle('ai:ask', async (e, { key, body }) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, status: res.status, text: (await res.text()).slice(0, 400) };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '', stop = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        out += ev.delta.text;
        e.sender.send('ai:chunk', ev.delta.text);
      } else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      else if (ev.type === 'error') return { ok: false, status: 0, text: ev.error?.message || 'ошибка потока' };
    }
  }
  return { ok: true, text: out, stop };
});

/* ── самопроверка сборки ──────────────────────────────────────────────────────
   Собранное приложение нельзя проверить теми же средствами, что страницу в
   браузере, — поэтому оно умеет проверить себя само: SHARDS_SELFTEST=1 гоняет
   экраны, печатает результат в stdout и выходит. Читает, но ничего не пишет. */
async function runSelfTest() {
  const log = o => process.stdout.write('SELFTEST ' + JSON.stringify(o) + '\n');
  try {
    await new Promise(r => win.webContents.once('did-finish-load', r));
    const res = await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const errs = [];
      addEventListener('error', e => errs.push(e.message));
      addEventListener('unhandledrejection', e => errs.push(String(e.reason?.message || e.reason)));
      await wait(2500);
      const out = { мост: !!window.shardsNative, узлы: window.__shards_graph?.nodes.length || 0 };
      const api = await import('app://oskolki/js/api.js');
      out.транспорт = api.transport?.native ? 'вальт с диска' : (api.transport?.demo ? 'демо' : 'воркер');
      const t0 = performance.now();
      out.списокКорня = (await api.tools.list('')).split('\\n').length;
      out.чтениеМс = Math.round(performance.now() - t0);
      const c = await import('app://oskolki/js/corpus.js');
      const r = c.searchCorpus('переезд ереван', 5);
      out.поиск = r.results.slice(0, 3).map(x => x.path);
      location.hash = '#/cards'; await wait(600);
      out.картотека = document.querySelectorAll('#k-body .trow').length - 1;
      location.hash = '#/ask'; await wait(500);
      out.экранСпросить = !!document.querySelector('#a-q');
      location.hash = '#/graph'; await wait(600);

      // Запись проверяем только по явной команде и только на том вальте,
      // который передан снаружи: случайный прогон не должен писать в память.
      if (${JSON.stringify(process.env.SHARDS_SELFTEST === 'write')}) {
        const w = await import('app://oskolki/js/write.js');
        out.мысль1 = await w.appendThought('первая мысль из приложения');
        out.мысль2 = await w.appendThought('вторая мысль из приложения');
        out.заметка = await w.createNote({ title: 'Проверка из приложения', zone: 'brain', template: 'templates/Заметка.md', body: 'Текст под заголовком. Связь: [[hot]]' });
        out.деньПосле = (await api.tools.read(w.dailyPath())).split('## Мысли')[1].trim();
      }
      out.ошибки = errs;
      return out;
    })()`);
    log({ ok: true, ...res });
  } catch (e) {
    log({ ok: false, ошибка: e.message });
  }
  app.isQuitting = true;
  app.quit();
}

/* ── старт ────────────────────────────────────────────────────────────────── */

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    // app:// вместо file:// — иначе ES-модули не грузятся (origin null → CORS).
    protocol.handle('app', req => {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = join(ROOT, path);
      const rel = relative(ROOT, file);
      if (rel.startsWith('..')) return new Response('нет', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    await loadSettings();
    createWindow();
    createTray();
    watchVault();

    // Мысль ловится из любого приложения — в этом половина смысла десктопа.
    if (!globalShortcut.register('CommandOrControl+Shift+M', captureThought)) {
      console.warn('глобальный хоткей занят другим приложением');
    }

    if (process.env.SHARDS_SELFTEST) runSelfTest();
  });

  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); watcher?.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') { /* живём в трее */ } });
  app.on('activate', showWindow);
}
