/**
 * Bridge between the sandboxed renderer and the main process. Exposes a small,
 * explicit API on window.alpaca — no Node access leaks into the page.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('alpaca', {
  status: () => ipcRenderer.invoke('host:status'),
  pair: (opts) => ipcRenderer.invoke('host:pair', opts),
  launch: (opts) => ipcRenderer.invoke('host:launch', opts),
  stop: (sid) => ipcRenderer.invoke('host:stop', { sid }),
  stopAll: () => ipcRenderer.invoke('host:stopAll'),
  unpair: () => ipcRenderer.invoke('host:unpair'),
  sendInput: (sid, data) => ipcRenderer.send('session:input', { sid, data }),
  resize: (sid, cols, rows) => ipcRenderer.send('session:resize', { sid, cols, rows }),
  openExternal: (url) => ipcRenderer.send('open:external', url),
  on: (channel, cb) => {
    const allowed = ['session:started', 'session:data', 'session:status', 'session:exit', 'session:error'];
    if (!allowed.includes(channel)) return;
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
