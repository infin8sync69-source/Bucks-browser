// The agent's hands: runs the Soul Engine's browser_* tools (read, navigate, click, type, scroll,
// screenshot) on the user's tab, and its document tools (create_document, create_pdf,
// page_to_pdf). Page scripts run in an isolated world, so the page cannot tamper with them; only
// the DOM is shared (elements get a data-bucks-ref attribute so a later click finds them).
//
// Which tools change the page, and therefore always need the user's approval, is decided here as
// well as by the engine (STATE_CHANGING): the main process never clicks, types or navigates on the
// strength of the engine's needs_approval flag alone.

import { createLogger } from '../log.js';

const log = createLogger('browser-control');

const WORLD_ID = 1017;
const MAX_ELEMENTS = 150;
const SETTLE_CLICK_MS = 800;
const NAVIGATE_TIMEOUT_MS = 10_000;
const SCREENSHOT_WIDTH = 1280;

/** Tools that change the page: approval required whatever the engine says. */
export const STATE_CHANGING = Object.freeze(new Set(['browser_click', 'browser_type', 'browser_navigate', 'pane_open', 'pane_close']));
/** Tools that act on the user's tab (only allowed when the request asked for it). */
export const TAB_TOOLS = Object.freeze(new Set(['browser_read_page', 'browser_navigate', 'browser_click', 'browser_type', 'browser_scroll', 'browser_screenshot']));
const PANE_TOOLS = new Set(['panes_list', 'pane_open', 'pane_close', 'pane_focus', 'pane_arrange', 'workspace_sweep']);
/** Every tool this module runs (the engine waits for a tool_result for each of them). */
export const REMOTE_TOOLS = Object.freeze(new Set([...TAB_TOOLS, ...PANE_TOOLS, 'create_document', 'create_pdf', 'page_to_pdf']));

export const SNAPSHOT_SCRIPT = `(() => {
  const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=textbox], [role=checkbox], [role=tab], [onclick], [contenteditable=true], [contenteditable=""]';
  for (const old of document.querySelectorAll('[data-bucks-ref]')) old.removeAttribute('data-bucks-ref');
  const out = [];
  let ref = 0;
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || style.visibility === 'hidden' || style.display === 'none') continue;
    if (r.bottom < -200 || r.top > (innerHeight || 800) + 800) continue;
    el.setAttribute('data-bucks-ref', String(ref));
    const tag = el.tagName.toLowerCase();
    let name = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (tag === 'input' && el.type !== 'password' ? el.value : '') || el.innerText || el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\\s+/g, ' ');
    if (name.length > 80) name = name.slice(0, 80) + '…';
    out.push({ ref, role: el.getAttribute('role') || tag, type: tag === 'input' ? (el.type || 'text') : '', name, href: tag === 'a' ? el.href.slice(0, 200) : '' });
    if (++ref >= ${MAX_ELEMENTS}) break;
  }
  return { url: location.href, title: document.title, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight, elements: out };
})()`;

const refScript = (ref, body) => `(() => {
  const el = document.querySelector('[data-bucks-ref="${Number(ref)}"]');
  if (!el) return { ok: false, error: 'No element [${Number(ref)}] on the page any more. Read the page again.' };
  ${body}
})()`;

/** The snapshot as text the model can reason over. */
export function formatSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return 'No page loaded.';
  const els = Array.isArray(snap.elements) ? snap.elements : [];
  return [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`,
    `Scroll: ${snap.scrollY}/${snap.scrollHeight}`,
    els.length ? 'Interactive elements:' : 'No interactive elements in view.',
    ...els.map((e) => `[${e.ref}] ${e.role}${e.type ? `(${e.type})` : ''}: ${e.name || '(no label)'}${e.href ? ` → ${e.href}` : ''}`),
  ].join('\n');
}

/** A URL the agent may open: http(s), ipfs, ipns; a bare host gets https://. Throws otherwise. */
export function agentUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) throw new Error('browser_navigate needs a url');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (!['http:', 'https:', 'ipfs:', 'ipns:'].includes(u.protocol)) throw new Error(`The agent may only open http, https, ipfs and ipns addresses, not ${u.protocol}`);
  return u.href;
}

/** A short, human description of a tool call, for status lines and approval cards. */
export function describeAction(name, args = {}) {
  switch (name) {
    case 'browser_read_page': return 'Reading the page';
    case 'browser_navigate': return `Open ${String(args.url ?? '').slice(0, 200)}`;
    case 'browser_click': return `Click element [${args.ref}]${args.label ? ` "${String(args.label).slice(0, 60)}"` : ''}`;
    case 'browser_type': return `Type "${String(args.text ?? '').slice(0, 80)}" into [${args.ref}]`;
    case 'browser_scroll': return `Scroll ${args.direction === 'up' ? 'up' : 'down'}`;
    case 'browser_screenshot': return 'Taking a screenshot of the page';
    case 'create_document': return `Writing the document "${String(args.title ?? 'Document').slice(0, 80)}"`;
    case 'create_pdf': return `Writing the PDF "${String(args.title ?? 'Report').slice(0, 80)}"`;
    case 'page_to_pdf': return 'Saving the page as a PDF';
    default: return name.replace(/_/g, ' ');
  }
}

/**
 * @param {{
 *   tabs: { getWebContents(id: string): import('electron').WebContents | null, navigate(id: string, url: string): unknown },
 *   docs: { create(p: object): Promise<{ path: string }>, savePdf(title: string, buf: Buffer): Promise<{ path: string }> },
 *   wait?: (ms: number) => Promise<void>,
 * }} deps
 */
export function createBrowserControl({ tabs, docs, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  function webContentsOf(tabId) {
    const wc = tabId ? tabs.getWebContents(tabId) : null;
    if (!wc || wc.isDestroyed()) throw new Error('No web page is open in the tab the request came from. Ask the user to open one first.');
    return wc;
  }

  const run = (wc, code, gesture = false) => wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }], gesture);
  const snapshot = async (wc) => formatSnapshot(await run(wc, SNAPSHOT_SCRIPT).catch(() => null));

  function waitForLoad(wc) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); wc.removeListener('did-stop-loading', done); resolve(); };
      const timer = setTimeout(done, NAVIGATE_TIMEOUT_MS);
      wc.once('did-stop-loading', done);
    });
  }

  /**
   * Run one tool. Errors become text the model can read, never exceptions.
   * @param {string} name
   * @param {object} args
   * @param {{ tabId: string | null, tabTools: boolean, onFile?: (path: string) => void }} ctx
   *   tabTools: the user asked the agent to act in the tab; onFile: told about each document written
   * @returns {Promise<string | { text: string, screenshot_b64: string, media_type: string }>}
   */
  async function execute(name, args, { tabId, tabTools, onFile = () => {} }) {
    const a = args && typeof args === 'object' ? args : {};
    try {
      if (TAB_TOOLS.has(name) && !tabTools) return 'Acting in the browser tab was not enabled for this request. Answer without it.';
      if (PANE_TOOLS.has(name)) return 'Bucks Browser has no split panes yet. Use browser_navigate on the current tab instead.';
      if ((name === 'browser_click' || name === 'browser_type') && !(Number.isInteger(Number(a.ref)) && Number(a.ref) >= 0)) {
        return `${name} needs the [ref] number of an element from browser_read_page.`;
      }
      switch (name) {
        case 'browser_read_page':
          return await snapshot(webContentsOf(tabId));
        case 'browser_navigate': {
          const url = agentUrl(a.url);
          const wc = webContentsOf(tabId);
          const loaded = waitForLoad(wc);
          tabs.navigate(tabId, url);
          await loaded;
          return `Opened ${url}\n\n${await snapshot(wc)}`;
        }
        case 'browser_click': {
          const wc = webContentsOf(tabId);
          const r = await run(wc, refScript(a.ref, "el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true };"), true);
          if (!r?.ok) return `Click failed: ${r?.error || 'unknown error'}`;
          await wait(SETTLE_CLICK_MS);
          return `Clicked [${a.ref}].\n\n${await snapshot(wc)}`;
        }
        case 'browser_type': {
          const wc = webContentsOf(tabId);
          const text = String(a.text ?? '').slice(0, 5000);
          const r = await run(wc, refScript(a.ref, `
            el.scrollIntoView({ block: 'center' });
            el.focus();
            if (typeof el.select === 'function') el.select();
            else { const range = document.createRange(); range.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
            return { ok: document.activeElement === el || el.contains(document.activeElement) };`), true);
          if (!r?.ok) return `Typing failed: ${r?.error || 'the element did not take the focus'}`;
          await wc.insertText(text); // real text input: works with every framework's change tracking
          return `Typed into [${a.ref}].`;
        }
        case 'browser_scroll': {
          const wc = webContentsOf(tabId);
          await run(wc, `scrollBy(0, ${a.direction === 'up' ? -1 : 1} * Math.round(innerHeight * 0.85))`);
          return await snapshot(wc);
        }
        case 'browser_screenshot': {
          const wc = webContentsOf(tabId);
          let image = await wc.capturePage();
          if (image.getSize().width > SCREENSHOT_WIDTH) image = image.resize({ width: SCREENSHOT_WIDTH });
          return { text: 'Screenshot of the current tab.', screenshot_b64: image.toPNG().toString('base64'), media_type: 'image/png' };
        }
        case 'create_document': {
          const format = a.format === 'txt' || a.format === 'html' ? a.format : 'md';
          const r = await docs.create({ title: a.title || 'Document', content: String(a.content ?? ''), format });
          onFile(r.path);
          return `Document saved to ${r.path}`;
        }
        case 'create_pdf': {
          const r = await docs.create({ title: a.title || 'Report', content: String(a.content ?? ''), format: 'pdf' });
          onFile(r.path);
          return `PDF report saved to ${r.path}`;
        }
        case 'page_to_pdf': {
          const wc = webContentsOf(tabId);
          const r = await docs.savePdf(a.title || wc.getTitle() || 'Page', await wc.printToPDF({ printBackground: true }));
          onFile(r.path);
          return `Page saved as PDF: ${r.path}`;
        }
        default:
          return `Unknown browser tool: ${name}`;
      }
    } catch (e) {
      log.debug(`${name} failed: ${e.message}`);
      return `Tool error: ${e.message}`;
    }
  }

  return { execute };
}
