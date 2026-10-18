// Offline provider: deterministic intent rules. Always available, needs no model or server.
// Pure functions apart from the exported provider object (no Electron imports).

import { isCid } from '../../ipfs/cid.js';

/** Same catalogue as ui/src/lib/search.ts. */
export const SEARCH_ENGINES = Object.freeze({
  duckduckgo: 'https://duckduckgo.com/?q=',
  google: 'https://www.google.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
});

/** Search results URL for `query` (unknown engines fall back to DuckDuckGo). */
export function buildSearchUrl(engine, query) {
  return (SEARCH_ENGINES[engine] || SEARCH_ENGINES.duckduckgo) + encodeURIComponent(query);
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#].*)?$/i;
const LOCAL = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#].*)?$/i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * Turn something a user typed into a navigable URL, or null when it is not a URL-like thing.
 * - http(s)://, ipfs://, ipns:// pass through; other schemes (javascript:, file:, data:) are rejected
 * - bare CIDs (optionally with a /path) become ipfs://<cid>/path; "/ipfs/<cid>" paths too
 * - bare domains get https://; localhost and IP literals get http://
 * @param {string} input
 * @returns {string | null}
 */
export function resolveUrl(input) {
  let s = String(input ?? '').trim().replace(/^["'(<[]+/, '');
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = s.replace(/[>.,;:!?"')\]}]+$/, '');
    return /^(https?|ipfs|ipns):\/\//i.test(s) ? s : null;
  }
  s = s.replace(TRAILING_PUNCTUATION, '');
  const ipfsPath = /^\/(ipfs|ipns)\/(.+)$/i.exec(s);
  if (ipfsPath) return `${ipfsPath[1].toLowerCase()}://${ipfsPath[2]}`;
  const head = s.split('/')[0];
  if (head.length >= 40 && isCid(head)) return `ipfs://${s}`;
  if (LOCAL.test(s)) return `http://${s}`;
  if (DOMAIN.test(s)) return `https://${s}`;
  return null;
}

const NAV_VERB = /^(?:(?:please|pls|hey|ok|okay)[\s,]+)?(?:(?:can|could|would) you (?:please )?)?(?:go to|goto|open up|open|navigate to|navigate|browse to|browse|visit|take me to|load)\s+(.+)$/i;
const SEARCH_VERB = /\b(?:search(?:\s+the\s+(?:web|internet))?(?:\s+for)?|look\s+up|google|find(?:\s+me)?)\s+(.+)$/i;

const INTERNAL_PAGES = [
  { re: /^(?:my |the |bucks )?(?:wallet|balance|payments?)(?: page)?$/i, action: 'open_wallet', content: 'Opening your Bucks wallet...' },
  { re: /^(?:my |the )?(?:ipfs|node|pins?|ipfs node|ipfs workspace)(?: page)?$/i, action: 'open_ipfs', content: 'Opening the IPFS workspace...' },
  { re: /^(?:my |the |browser )?(?:settings|preferences|options)(?: page)?$/i, action: 'open_settings', content: 'Opening settings...' },
  { re: /^(?:my |the )?downloads?(?: page| list| folder)?$/i, action: 'open_downloads', content: 'Opening your downloads...' },
];

const KEYWORD_ACTIONS = [
  { re: /\b(?:wallet|pay|payments?|balance|send money)\b/i, action: 'open_wallet', content: 'Opening your Bucks wallet...' },
  { re: /\b(?:ipfs|pinning|pinned|pin|node|cid)\b/i, action: 'open_ipfs', content: 'Opening the IPFS workspace...' },
  { re: /\b(?:settings|preferences|options)\b/i, action: 'open_settings', content: 'Opening settings...' },
  { re: /\bdownloads?\b/i, action: 'open_downloads', content: 'Opening your downloads...' },
];

function actionResult(rule) {
  return result({ type: 'action', action: rule.action, content: rule.content });
}

function result(a2ui) {
  return { status: 'offline_fallback', evaluation: a2ui.content || '', a2ui };
}

function navigateResult(url, newTab) {
  return result({ type: newTab ? 'open_tab' : 'navigate', url, content: `${newTab ? 'Opening' : 'Navigating to'} ${url}...` });
}

function searchResult(query, engine) {
  const q = query.trim();
  return result({ type: 'navigate', url: buildSearchUrl(engine, q), content: `Searching for '${q}'...` });
}

/** First token in `text` that is URL-like, resolved; otherwise null. */
function findUrlIn(text) {
  for (const token of text.split(/\s+/)) {
    const url = resolveUrl(token);
    if (url) return url;
  }
  return null;
}

const HELP_TEXT =
  "I'm running in offline mode, so I can only handle simple commands: " +
  "\"go to <site>\" (domains, ipfs:// links and bare CIDs work), \"search <something>\", " +
  '"wallet", "ipfs", "settings" and "downloads". ' +
  'To get full answers, choose an AI provider (a local Ollama model or a Bucks agent server) in Settings.';

/**
 * Classify a prompt with deterministic rules.
 * @param {string} prompt
 * @param {{ searchEngine?: string }} [cfg]
 * @returns {{ status: 'offline_fallback', evaluation: string, a2ui: object }}
 */
export function interpretPrompt(prompt, cfg = {}) {
  const text = String(prompt ?? '').trim();
  const engine = cfg.searchEngine;
  if (!text) return result({ type: 'text', content: HELP_TEXT });

  // A lone URL, domain or CID is just a navigation.
  const direct = resolveUrl(text);
  if (direct && !/\s/.test(text)) return navigateResult(direct, false);

  const nav = NAV_VERB.exec(text);
  if (nav) {
    const target = nav[1].trim();
    const wantsNewTab = /\b(?:new|another)\s+tab\b/i.test(target);
    const cleaned = target.replace(/\b(?:in\s+(?:a\s+)?(?:new|another)\s+tab|(?:the\s+)?(?:web)?site|page)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    for (const page of INTERNAL_PAGES) if (page.re.test(cleaned)) return actionResult(page);
    const url = resolveUrl(cleaned) || findUrlIn(target);
    if (url) return navigateResult(url, wantsNewTab);
    if (cleaned) return searchResult(cleaned.replace(/^the\s+/i, ''), engine);
  }

  const search = SEARCH_VERB.exec(text);
  if (search) {
    const query = search[1].replace(/^(?:for|up)\s+/i, '').trim();
    if (query) return searchResult(query, engine);
  }

  const bareUrl = findUrlIn(text);
  if (bareUrl && text.split(/\s+/).length <= 3) return navigateResult(bareUrl, false);

  for (const rule of KEYWORD_ACTIONS) if (rule.re.test(text)) return actionResult(rule);

  return result({ type: 'text', content: HELP_TEXT });
}

/** The offline provider: { name, isAvailable, query }. */
export const offlineProvider = {
  name: 'offline',
  /** Always available. */
  async isAvailable() {
    return true;
  },
  /**
   * @param {{ prompt: string }} input
   * @param {{ searchEngine?: string }} cfg
   */
  async query({ prompt }, cfg = {}) {
    return interpretPrompt(prompt, cfg);
  },
};

export default offlineProvider;
