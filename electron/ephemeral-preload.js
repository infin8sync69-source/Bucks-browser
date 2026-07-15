const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ephemeralAPI', {
  submitQuery: (query) => ipcRenderer.invoke('ephemeral:submit', { query }),
  hide: () => ipcRenderer.send('ephemeral:hide'),
  onFocusInput: (callback) => ipcRenderer.on('focus-input', callback)
});
