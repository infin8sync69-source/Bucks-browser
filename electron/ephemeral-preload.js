const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ephemeralAPI', {
  // Route query to main window chat pipeline (legacy / "Open in chat" action)
  submitQuery: (query) => ipcRenderer.invoke('ephemeral:submit', { query }),
  // Hide the ephemeral window immediately
  hide: () => ipcRenderer.send('ephemeral:hide'),
  // Resize the window height (used when streaming response expands the UI)
  resize: (height) => ipcRenderer.send('ephemeral:resize', { height }),
  // Focus-input event sent when the window is shown via Cmd+K
  onFocusInput: (callback) => ipcRenderer.on('focus-input', callback)
});
