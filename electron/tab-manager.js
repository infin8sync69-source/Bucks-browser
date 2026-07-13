/* ╔══════════════════════════════════════════════════════════╗
   ║  BUCKS TAB MANAGER — main-process WebContentsView host      ║
   ║                                                            ║
   ║  Replaces the legacy <webview> tag for tab hosting. Each   ║
   ║  tab is a first-class WebContentsView child of the window  ║
   ║  (Chrome-grade site isolation & performance). The renderer ║
   ║  keeps a placeholder <div> per tab (tab-view.js) and       ║
   ║  mirrors its geometry/visibility here over IPC.            ║
   ║                                                            ║
   ║  Channels (invoke): tabs:create/navigate/close/setBounds/  ║
   ║    setVisible/goBack/goForward/reload/stop/setZoom/find/   ║
   ║    stopFind/execJS/capture/print/openDevTools              ║
   ║  Events (send): 'tabs:event' {tabId, type, ...payload}     ║
   ╚══════════════════════════════════════════════════════════╝ */
'use strict';

const { WebContentsView, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');

/** tabId -> { view, winId, lastBounds, visible } */
const tabsById = new Map();

function _win(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

function _shellSend(winId, payload) {
  const win = BrowserWindow.fromId(winId);
  if (win && !win.isDestroyed()) win.webContents.send('tabs:event', payload);
}

function _navState(wc) {
  const h = wc.navigationHistory;
  return h
    ? { canGoBack: h.canGoBack(), canGoForward: h.canGoForward() }
    : { canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() };
}

function _wireEvents(tabId, winId, view) {
  const wc = view.webContents;
  const send = (type, payload = {}) => _shellSend(winId, { tabId, type, ...payload });
  const sendNav = () => send('nav-state', _navState(wc));

  wc.on('did-start-loading', () => send('did-start-loading'));
  wc.on('did-stop-loading', () => { send('did-stop-loading'); sendNav(); });
  wc.on('page-title-updated', (_e, title) => send('page-title-updated', { title }));
  wc.on('page-favicon-updated', (_e, favicons) => send('page-favicon-updated', { favicons }));
  wc.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    if (isMainFrame) send('did-start-navigation', { url });
  });
  wc.on('did-navigate', (_e, url) => { send('did-navigate', { url }); sendNav(); });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) { send('did-navigate-in-page', { url }); sendNav(); }
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 /* ERR_ABORTED: benign */) {
      send('did-fail-load', { errorCode: code, errorDescription: desc, validatedURL: url });
    }
  });
  wc.on('found-in-page', (_e, result) => send('found-in-page', { result }));

  // Popups / target=_blank → let the shell open them as tabs.
  wc.setWindowOpenHandler(({ url }) => {
    send('new-window', { url });
    return { action: 'deny' };
  });

  // HTML fullscreen (e.g. video players): expand to the whole window, then
  // restore the tracked placeholder bounds on exit.
  wc.on('enter-html-full-screen', () => {
    const win = BrowserWindow.fromId(winId);
    const rec = tabsById.get(tabId);
    if (win && rec) {
      const [w, h] = win.getContentSize();
      view.setBounds({ x: 0, y: 0, width: w, height: h });
    }
  });
  wc.on('leave-html-full-screen', () => {
    const rec = tabsById.get(tabId);
    if (rec && rec.lastBounds) view.setBounds(rec.lastBounds);
  });

  // Native context menu — floats above the view (OS-level), giving proper
  // browser UX that DOM menus can't provide over a native view.
  wc.on('context-menu', (_e, params) => {
    const items = [];
    const nav = _navState(wc);
    items.push(
      { label: 'Back', enabled: nav.canGoBack, click: () => wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack() },
      { label: 'Forward', enabled: nav.canGoForward, click: () => wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
    );
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => send('new-window', { url: params.linkURL }) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.selectionText) {
      items.push({ label: 'Copy', role: 'copy' }, { type: 'separator' });
    }
    if (params.isEditable) {
      items.push(
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { type: 'separator' },
      );
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) }, { type: 'separator' });
    }
    items.push({ label: 'Inspect Element', click: () => { wc.inspectElement(params.x, params.y); } });
    Menu.buildFromTemplate(items).popup();
  });
}

function _get(tabId) {
  const rec = tabsById.get(tabId);
  if (!rec || rec.view.webContents.isDestroyed()) return null;
  return rec;
}

function destroyTabsForWindow(winId) {
  for (const [tabId, rec] of tabsById) {
    if (rec.winId === winId) {
      try { rec.view.webContents.close(); } catch (_) {}
      tabsById.delete(tabId);
    }
  }
}

function setupTabIPC() {
  ipcMain.handle('tabs:create', (e, { tabId, url, partition }) => {
    const win = _win(e);
    if (!win || tabsById.has(tabId)) return false;
    const view = new WebContentsView({
      webPreferences: {
        partition: partition || undefined,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    view.setVisible(false);
    win.contentView.addChildView(view);
    tabsById.set(tabId, { view, winId: win.id, lastBounds: null, visible: false });
    _wireEvents(tabId, win.id, view);
    if (url) view.webContents.loadURL(url).catch(() => {});
    return true;
  });

  ipcMain.handle('tabs:close', (_e, { tabId }) => {
    const rec = tabsById.get(tabId);
    if (!rec) return false;
    const win = BrowserWindow.fromId(rec.winId);
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(rec.view); } catch (_) {}
    try { rec.view.webContents.close(); } catch (_) {}
    tabsById.delete(tabId);
    return true;
  });

  ipcMain.handle('tabs:navigate', (_e, { tabId, url }) => {
    const rec = _get(tabId);
    if (rec) rec.view.webContents.loadURL(url).catch(() => {});
    return !!rec;
  });

  ipcMain.handle('tabs:setBounds', (_e, { tabId, bounds }) => {
    const rec = _get(tabId);
    if (!rec) return false;
    const b = {
      x: Math.round(bounds.x), y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    rec.lastBounds = b;
    rec.view.setBounds(b);
    return true;
  });

  ipcMain.handle('tabs:setVisible', (_e, { tabId, visible }) => {
    const rec = _get(tabId);
    if (!rec) return false;
    rec.visible = !!visible;
    rec.view.setVisible(!!visible);
    // Raise the active view above sibling views (last child paints on top).
    if (visible) {
      const win = BrowserWindow.fromId(rec.winId);
      if (win && !win.isDestroyed()) {
        try { win.contentView.addChildView(rec.view); } catch (_) {}
      }
    }
    return true;
  });

  ipcMain.handle('tabs:setBorderRadius', (_e, { tabId, radius }) => {
    const rec = _get(tabId);
    if (rec && typeof rec.view.setBorderRadius === 'function') {
      try { rec.view.setBorderRadius(radius); } catch (_) {}
      return true;
    }
    return false;
  });

  ipcMain.handle('tabs:goBack', (_e, { tabId }) => {
    const rec = _get(tabId);
    if (rec) {
      const wc = rec.view.webContents;
      wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack();
    }
  });
  ipcMain.handle('tabs:goForward', (_e, { tabId }) => {
    const rec = _get(tabId);
    if (rec) {
      const wc = rec.view.webContents;
      wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward();
    }
  });
  ipcMain.handle('tabs:reload', (_e, { tabId }) => { const r = _get(tabId); if (r) r.view.webContents.reload(); });
  ipcMain.handle('tabs:stop', (_e, { tabId }) => { const r = _get(tabId); if (r) r.view.webContents.stop(); });
  ipcMain.handle('tabs:setZoom', (_e, { tabId, factor }) => { const r = _get(tabId); if (r) r.view.webContents.setZoomFactor(factor); });
  ipcMain.handle('tabs:print', (_e, { tabId }) => { const r = _get(tabId); if (r) r.view.webContents.print(); });
  ipcMain.handle('tabs:openDevTools', (_e, { tabId }) => { const r = _get(tabId); if (r) r.view.webContents.openDevTools({ mode: 'detach' }); });

  ipcMain.handle('tabs:find', (_e, { tabId, text, options }) => {
    const rec = _get(tabId);
    if (rec && text) rec.view.webContents.findInPage(text, options || {});
  });
  ipcMain.handle('tabs:stopFind', (_e, { tabId, action }) => {
    const rec = _get(tabId);
    if (rec) rec.view.webContents.stopFindInPage(action || 'clearSelection');
  });

  ipcMain.handle('tabs:execJS', async (_e, { tabId, code, userGesture }) => {
    const rec = _get(tabId);
    if (!rec) throw new Error('No such tab');
    return rec.view.webContents.executeJavaScript(code, !!userGesture);
  });

  ipcMain.handle('tabs:capture', async (_e, { tabId }) => {
    const rec = _get(tabId);
    if (!rec) throw new Error('No such tab');
    const img = await rec.view.webContents.capturePage();
    return img.toPNG().toString('base64');
  });

  ipcMain.handle('tabs:getURL', (_e, { tabId }) => {
    const rec = _get(tabId);
    return rec ? rec.view.webContents.getURL() : '';
  });
}

module.exports = { setupTabIPC, destroyTabsForWindow };
