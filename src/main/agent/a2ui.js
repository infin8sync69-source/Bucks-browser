// A2UI: the small JSON "agent to UI" command language the chat drawer executes.
// Pure functions, no Electron imports (unit-testable).

export const A2UI_TYPES = Object.freeze(['navigate', 'open_tab', 'search', 'action', 'text']);
export const A2UI_ACTIONS = Object.freeze(['open_wallet', 'open_ipfs', 'open_settings', 'open_downloads']);
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'ipfs:', 'ipns:']);

/** True when `value` is an http(s)/ipfs/ipns URL that parses. */
export function isAllowedUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

/**
 * Validate and normalise a parsed object into an A2UI command.
 * Unknown fields are dropped (except a boolean `is_agent`). Returns null when invalid:
 * unknown type, missing/illegal url for navigate / open_tab, empty query for search,
 * unknown action for action.
 * @param {any} obj
 * @returns {{ type: string, url?: string, action?: string, content?: string, is_agent?: boolean } | null}
 */
export function validateA2ui(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!A2UI_TYPES.includes(obj.type)) return null;
  const out = { type: obj.type };
  if (typeof obj.content === 'string') out.content = obj.content.slice(0, 4000);

  if (obj.url !== undefined && obj.url !== null) {
    if (!isAllowedUrl(obj.url)) return null;
    out.url = obj.url.trim();
  }
  if (obj.type === 'navigate' || obj.type === 'open_tab') {
    if (!out.url) return null;
  } else if (obj.type === 'search') {
    if (!out.content || !out.content.trim()) return null;
  } else if (obj.type === 'action') {
    if (!A2UI_ACTIONS.includes(obj.action)) return null;
    out.action = obj.action;
  } else if (obj.type === 'text') {
    if (!out.content) return null;
  }
  if (typeof obj.is_agent === 'boolean') out.is_agent = obj.is_agent;
  return out;
}

/** Contents of every ``` fence in the text, in order, with their character span. */
function fencedBlocks(text) {
  const blocks = [];
  const re = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ lang: m[1].toLowerCase(), body: m[2], start: m.index, end: m.index + m[0].length });
  }
  return blocks;
}

/** End index (exclusive) of the JSON object starting at text[start] === '{', or -1. String-literal aware. */
function objectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

const MAX_SCAN = 20_000;

/**
 * Find the outermost {...} object that ends the text (only whitespace / fence remnants after it)
 * and validates as A2UI. Returns { a2ui, start, end } or null.
 */
function trailingObject(text) {
  const tail = text.length > MAX_SCAN ? text.length - MAX_SCAN : 0;
  for (let i = text.indexOf('{', tail); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = objectEnd(text, i);
    if (end === -1 || text.slice(end).replace(/[\s`]/g, '') !== '') continue;
    const a2ui = validateA2ui(tryParse(text.slice(i, end)));
    if (a2ui) return { a2ui, start: i, end };
  }
  return null;
}

function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Pull the A2UI command out of a model answer: the last fenced ```json block that validates,
 * otherwise a trailing bare JSON object. Never throws.
 * @param {string} text
 * @returns {ReturnType<typeof validateA2ui>}
 */
export function extractA2ui(text) {
  return extractWithSpan(text)?.a2ui ?? null;
}

function extractWithSpan(text) {
  if (typeof text !== 'string' || !text) return null;
  const blocks = fencedBlocks(text).filter((b) => b.lang === 'json' || b.lang === '');
  for (let i = blocks.length - 1; i >= 0; i--) {
    const a2ui = validateA2ui(tryParse(blocks[i].body.trim()));
    if (a2ui) return { a2ui, start: blocks[i].start, end: blocks[i].end };
  }
  return trailingObject(text);
}

/**
 * Split a model answer into the human-readable part and the A2UI command, so the raw JSON is
 * not shown in the chat bubble.
 * @param {string} text
 * @returns {{ text: string, a2ui: ReturnType<typeof validateA2ui> }}
 */
export function splitA2ui(text) {
  const found = extractWithSpan(text);
  if (!found) return { text: String(text ?? '').trim(), a2ui: null };
  const remaining = (text.slice(0, found.start) + text.slice(found.end)).replace(/\n{3,}/g, '\n\n').trim();
  return { text: remaining, a2ui: found.a2ui };
}
