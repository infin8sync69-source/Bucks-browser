// Documents the agent writes for you: an answer saved as Markdown, text, HTML or PDF, a research
// report (the Soul Engine's create_document / create_pdf tools) or a page saved as PDF
// (page_to_pdf). Files go to <Documents>/Bucks with a unique name; nothing is overwritten.
// PDFs are rendered from Markdown in a hidden, script-less window and printed by Chromium.
//
//   bucks:docs:create { title, content, format: 'md'|'txt'|'html'|'pdf' } → { path }
//   bucks:docs:show   { path }  reveals a file this module wrote in the file manager

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { createLogger } from './log.js';
import { pageStyle, DOCUMENT_CSS } from './design/page.js';

const log = createLogger('docs');

export const DOC_FORMATS = Object.freeze(['md', 'txt', 'html', 'pdf']);
const MAX_CONTENT = 2 * 1024 * 1024;
const MAX_TITLE = 120;

/* ───────────────────────────── Markdown → HTML ───────────────────────────── */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown: code, bold, italic, links (http, https, ipfs, ipns, mailto only). Input is raw text. */
export function inlineMarkdown(text) {
  const codes = [];
  let s = String(text).replace(/`([^`\n]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]\n]+)\]\(((?:https?|ipfs|ipns|mailto):[^\s)]+)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableRule = (l) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Block Markdown (headings, lists, quotes, code fences, tables, rules, paragraphs) to HTML. */
export function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMarkdown(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inlineMarkdown(h[2].replace(/\s+#+\s*$/, ''))}</h${h[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows = [];
      i += 1;
      while (i + 1 < lines.length && isTableRow(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inlineMarkdown(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flush(); out.push(`<blockquote>${inlineMarkdown(q[1])}</blockquote>`); continue; }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

/** A complete, script-free HTML document for a title and Markdown body. */
export function htmlDocument(title, markdown) {
  return `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:">
<title>${esc(title)}</title>${pageStyle(DOCUMENT_CSS)}</head><body>
${/^\s*#\s/.test(markdown) ? '' : `<h1>${esc(title)}</h1>\n`}${markdownToHtml(markdown)}
</body></html>`;
}

/* ───────────────────────────── files ───────────────────────────── */

/** A file name from a title: no path separators or reserved characters, at most 80 characters. */
export function safeFileName(title, ext) {
  const base = String(title || '').normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/(^|\s)\.+(?=\s|$)/g, ' ') // no "." or ".." parts
    .replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim() || 'Document';
  return `${base}.${ext}`;
}

function cleanTitle(title) {
  return (typeof title === 'string' ? title : '').trim().slice(0, MAX_TITLE) || 'Document';
}

/**
 * @param {{ getDir: () => string, renderPdf: (html: string) => Promise<Buffer>, fs?: typeof fsp }} deps
 *   getDir is read on every write (the Documents folder can change); renderPdf turns HTML into a PDF.
 */
export function createDocs({ getDir, renderPdf, fs = fsp }) {
  const written = new Set();

  /** Write `data` under a unique name in the documents folder. @returns {Promise<string>} the path */
  async function writeUnique(title, ext, data) {
    const dir = getDir();
    await fs.mkdir(dir, { recursive: true });
    const name = safeFileName(title, ext);
    const stem = name.slice(0, -(ext.length + 1));
    for (let n = 1; n < 1000; n++) {
      const file = path.join(dir, n === 1 ? name : `${stem} (${n}).${ext}`);
      try {
        await fs.writeFile(file, data, { flag: 'wx' });
        written.add(file);
        log.info(`Wrote ${file}`);
        return file;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new Error('Too many files with this name');
  }

  const api = {
    /** @returns {Promise<{ path: string }>} */
    async create({ title, content, format = 'md' }) {
      if (!DOC_FORMATS.includes(format)) throw new Error(`Unknown document format "${format}" (md, txt, html or pdf)`);
      if (typeof content !== 'string' || !content.trim()) throw new Error('The document is empty');
      if (content.length > MAX_CONTENT) throw new Error('The document is too large');
      const t = cleanTitle(title);
      if (format === 'pdf') return { path: await writeUnique(t, 'pdf', await renderPdf(htmlDocument(t, content))) };
      if (format === 'html') return { path: await writeUnique(t, 'html', htmlDocument(t, content)) };
      return { path: await writeUnique(t, format, content.endsWith('\n') ? content : `${content}\n`) };
    },

    /** Save PDF bytes (a page printed by Chromium). @returns {Promise<{ path: string }>} */
    async savePdf(title, buffer) {
      return { path: await writeUnique(cleanTitle(title), 'pdf', buffer) };
    },

    /** True for files this session wrote (only those may be revealed through IPC). */
    wrote: (file) => written.has(file),
    dir: () => getDir(),
  };
  return api;
}

/**
 * Register the IPC handlers. The PDF renderer is a hidden window with JavaScript off, loading the
 * generated HTML from a data: URL.
 * @param {{ app: import('electron').App, BrowserWindow: typeof import('electron').BrowserWindow }} electronDeps
 */
export function installDocs({ app, BrowserWindow }) {
  async function renderPdf(html) {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    try {
      await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html).toString('base64')}`);
      return await win.webContents.printToPDF({ printBackground: true, margins: { marginType: 'default' } });
    } finally {
      win.destroy();
    }
  }
  const docs = createDocs({ getDir: () => path.join(app.getPath('documents'), 'Bucks'), renderPdf });

  ipcMain.removeHandler?.('bucks:docs:create');
  ipcMain.handle('bucks:docs:create', (_e, p) => docs.create({ title: p?.title, content: p?.content, format: p?.format }));
  ipcMain.removeHandler?.('bucks:docs:show');
  ipcMain.handle('bucks:docs:show', (_e, p) => {
    const file = typeof p?.path === 'string' ? p.path : '';
    if (!docs.wrote(file)) throw new Error('Only documents Bucks saved can be shown');
    shell.showItemInFolder(file);
  });
  return docs;
}
