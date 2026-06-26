// Desktop wrapper: runs the file-manager server in-process and shows it in a native window.
const { app, BrowserWindow, shell } = require('electron');

process.env.PORT = process.env.PORT || '39393'; // avoid clashing with a standalone server on 3939
require('./server.js');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Bucks Files',
    backgroundColor: '#1e2128',
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  win.loadURL(`http://127.0.0.1:${process.env.PORT}`);
  // downloads and external links go through the OS
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(createWindow);
app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
app.on('window-all-closed', () => app.quit());
