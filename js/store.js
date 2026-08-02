// Локальное хранилище: офлайн-копия корпуса и очередь неотправленных записей.
//
// Две разные задачи, одна база.
//
// КОПИЯ КОРПУСА. Индекс — это пять шардов по 400 КБ, и каждый запуск приложения
// начинался с их выкачивания: несколько секунд пустого экрана, а в метро или
// самолёте — экран ошибки вместо памяти. Копия делает старт мгновенным: граф
// рисуется из кэша, свежий индекс подтягивается фоном и подменяет модель.
//
// ОЧЕРЕДЬ ЗАПИСЕЙ. Мысль, набранная без сети, не должна пропадать: она ложится
// в очередь и уходит в вальт, как только связь вернётся. Порядок сохраняется —
// записи идут в вальт в том же порядке, в каком их набирали.
const DB_NAME = 'shards';
const DB_VERSION = 1;
const CORPUS = 'corpus';
const QUEUE = 'queue';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('IndexedDB недоступна'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CORPUS)) db.createObjectStore(CORPUS);
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(e => { dbPromise = null; throw e; });
  return dbPromise;
}

const tx = async (store, mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

/* ── копия корпуса ────────────────────────────────────────────────────────── */

// Ключ — адрес воркера: у разных вальтов (боевой, стенд, демо) свои копии,
// иначе на стенде можно увидеть боевой граф и наоборот.
const key = url => `index:${url || 'demo'}`;

export async function saveIndexCache(url, raw) {
  try {
    await tx(CORPUS, 'readwrite', s => s.put({ ...raw, savedAt: new Date().toISOString() }, key(url)));
    return true;
  } catch { return false; }   // приватный режим, полный диск — не повод падать
}

export async function loadIndexCache(url) {
  try { return (await tx(CORPUS, 'readonly', s => s.get(key(url)))) || null; }
  catch { return null; }
}

export async function clearIndexCache(url) {
  try { await tx(CORPUS, 'readwrite', s => s.delete(key(url))); } catch {}
}

/* ── очередь записей ──────────────────────────────────────────────────────── */

export async function queuePush(item) {
  try { await tx(QUEUE, 'readwrite', s => s.add({ ...item, at: new Date().toISOString() })); return true; }
  catch { return false; }
}

export async function queueAll() {
  try { return (await tx(QUEUE, 'readonly', s => s.getAll())) || []; }
  catch { return []; }
}

export async function queueDrop(id) {
  try { await tx(QUEUE, 'readwrite', s => s.delete(id)); } catch {}
}

export async function queueCount() {
  try { return (await tx(QUEUE, 'readonly', s => s.count())) || 0; }
  catch { return 0; }
}
