// Right-click menus for web content (tab views only — never the chrome or devtools).

import { app, clipboard, Menu } from 'electron';
import { createLogger } from './log.js';

const log = createLogger('context-menu');

/** Same map as the chrome's omnibox. */
export const SEARCH_ENGINES = Object.freeze({
  duckduckgo: { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  google: { label: 'Google', url: 'https://google.com/search?q=' },
  brave: { label: 'Brave', url: 'https://search.brave.com/search?q=' },
  bing: { label: 'Bing', url: 'https://bing.com/search?q=' },
});

const SELECTION_LABEL_MAX = 32;

/**
 * Search URL for a query with the given engine id (unknown ids fall back to DuckDuckGo).
 * @param {string} engine
 * @param {string} query
 */
export function searchUrlFor(engine, query) {
  const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES.duckduckgo;
  return e.url + encodeURIComponent(String(query ?? '').trim());
}

function truncate(text, max = SELECTION_LABEL_MAX) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Build the menu template for a 'context-menu' event. Pure apart from the `actions` closures.
 * @param {Electron.ContextMenuParams} params
 * @param {{
 *   openInNewTab(url: string): void, copyText(text: string): void, saveImage(url: string): void,
 *   copyImage(): void, search(text: string): void, inspect(x: number, y: number): void,
 *   back(): void, forward(): void, reload(): void, canGoBack: boolean, canGoForward: boolean,
 * }} actions
 * @param {{ engine?: string }} [opts]
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function buildContextMenuTemplate(params, actions, { engine = 'duckduckgo' } = {}) {
  const items = [];
  const linkURL = params.linkURL || '';
  const srcURL = params.srcURL || '';
  const isImage = params.mediaType === 'image' && !!srcURL;
  const selection = (params.selectionText || '').trim();
  const flags = params.editFlags || {};
  const sep = () => {
    if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
  };

  if (linkURL) {
    items.push(
      { label: 'Open Link in New Tab', click: () => actions.openInNewTab(linkURL) },
      { label: 'Copy Link Address', click: () => actions.copyText(linkURL) },
    );
    sep();
  }

  if (isImage) {
    items.push(
      { label: 'Open Image in New Tab', click: () => actions.openInNewTab(srcURL) },
      { label: 'Save Image As…', click: () => actions.saveImage(srcURL) },
      { label: 'Copy Image', click: () => actions.copyImage() },
      { label: 'Copy Image Address', click: () => actions.copyText(srcURL) },
    );
    sep();
  }

  if (params.isEditable) {
    items.push(
      { role: 'undo', enabled: flags.canUndo !== false },
      { role: 'redo', enabled: flags.canRedo !== false },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut !== false },
      { role: 'copy', enabled: flags.canCopy !== false },
      { role: 'paste', enabled: flags.canPaste !== false },
      { role: 'selectAll', enabled: flags.canSelectAll !== false },
    );
    sep();
  } else if (selection) {
    items.push({ role: 'copy' });
  }

  if (selection) {
    const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES.duckduckgo;
    items.push({ label: `Search ${e.label} for “${truncate(selection)}”`, click: () => actions.search(selection) });
    sep();
  }

  if (!linkURL && !isImage && !params.isEditable && !selection) {
    items.push(
      { label: 'Back', enabled: !!actions.canGoBack, click: () => actions.back() },
      { label: 'Forward', enabled: !!actions.canGoForward, click: () => actions.forward() },
      { label: 'Reload', click: () => actions.reload() },
    );
    sep();
  }

  items.push({ label: 'Inspect Element', click: () => actions.inspect(params.x, params.y) });
  return items;
}

/**
 * Hook every tab web contents' 'context-menu' event.
 * @param {{ tabs: object, getMainWindow: () => import('electron').BrowserWindow | null, settings?: { get(): any } }} deps
 */
export function installContextMenu({ tabs, getMainWindow, settings }) {
  const currentEngine = () => {
    const s = settings?.get?.() ?? tabs.getSettings?.() ?? {};
    return typeof s.searchEngine === 'string' ? s.searchEngine : 'duckduckgo';
  };

  app.on('web-contents-created', (_event, contents) => {
    contents.on('context-menu', (_e, params) => {
      // Ownership is checked at click time: at 'web-contents-created' the tab is not registered yet.
      if (typeof tabs.ownsWebContents !== 'function' || !tabs.ownsWebContents(contents)) return;
      const tabId = tabs.idForWebContents?.(contents) ?? null;
      const nav = contents.navigationHistory;

      const actions = {
        openInNewTab: (url) => tabs.requestOpen(tabId, url, 'background-tab'),
        copyText: (text) => clipboard.writeText(text),
        saveImage: (url) => contents.downloadURL(url),
        copyImage: () => contents.copyImageAt(params.x, params.y),
        search: (text) => tabs.requestOpen(tabId, searchUrlFor(currentEngine(), text), 'foreground-tab'),
        inspect: (x, y) => contents.inspectElement(x, y),
        back: () => nav?.canGoBack() && nav.goBack(),
        forward: () => nav?.canGoForward() && nav.goForward(),
        reload: () => contents.reload(),
        canGoBack: !!nav?.canGoBack(),
        canGoForward: !!nav?.canGoForward(),
      };

      try {
        const menu = Menu.buildFromTemplate(buildContextMenuTemplate(params, actions, { engine: currentEngine() }));
        const win = getMainWindow();
        menu.popup(win && !win.isDestroyed() ? { window: win } : {});
      } catch (e) {
        log.warn(`context menu failed: ${e.message}`);
      }
    });
  });
}
