// Мост между интерфейсом и системой. Наружу отдаём ровно то, что нужно
// приложению, — никакого прямого доступа к файловой системе или Node из
// страницы: contextIsolation включён, и это не формальность, а единственное,
// что отделяет заметки от произвольного кода на странице.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shardsNative', {
  platform: process.platform,

  // вальт
  state: () => ipcRenderer.invoke('vault:state'),
  pick: () => ipcRenderer.invoke('vault:pick'),
  call: (name, args) => ipcRenderer.invoke('vault:call', name, args),
  reveal: path => ipcRenderer.invoke('vault:reveal', path),

  // изменения файлов вальта — местный «живой канал»
  onChanged: cb => { ipcRenderer.on('vault:changed', (_e, ev) => cb(ev)); },
  onVaultPicked: cb => { ipcRenderer.on('vault:picked', (_e, p) => cb(p)); },

  // команды из трея и глобального хоткея
  onCapture: cb => { ipcRenderer.on('shards:capture', () => cb()); },
  onRoute: cb => { ipcRenderer.on('shards:route', (_e, hash) => cb(hash)); },

  // разговор с ИИ через главный процесс: без CORS и без браузерных послаблений
  ask: (key, body, onChunk) => {
    const listener = (_e, chunk) => onChunk(chunk);
    ipcRenderer.on('ai:chunk', listener);
    return ipcRenderer.invoke('ai:ask', { key, body })
      .finally(() => ipcRenderer.removeListener('ai:chunk', listener));
  },
});
