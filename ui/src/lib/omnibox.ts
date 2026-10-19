/**
 * Omnibox suggestions: what was typed (as a URL or a search) first, then open tabs to switch to,
 * bookmarks and history that match. Pure: the caller passes the data and a resolver that turns
 * typed text into a URL (or a search URL).
 */

export type SuggestionKind = 'url' | 'search' | 'tab' | 'bookmark' | 'history';

export interface Suggestion {
    kind: SuggestionKind;
    /** Main line (a title, or what was typed). */
    label: string;
    /** Where it goes. For 'tab' the tab's URL. */
    url: string;
    /** Second line: the URL, shortened. */
    detail?: string;
    /** For 'tab': the tab to switch to. */
    tabId?: string;
}

interface Titled {
    url: string;
    title: string;
}

export interface SuggestionSources {
    tabs: Array<Titled & { id: string; customTitle?: string; private?: boolean; isAgentTab?: boolean }>;
    bookmarks: Titled[];
    history: Titled[];
    activeTabId?: string | null;
}

const MAX = { tab: 2, bookmark: 3, history: 4 };

/** Rough "is this an address rather than words" test, matching how the omnibox resolves input. */
export function looksLikeUrl(input: string): boolean {
    const s = input.trim();
    if (!s || /\s/.test(s)) return false;
    return /^(bucks|https?|file|ipfs|ipns):/i.test(s)
        || /^localhost(:\d+)?($|[/?#])/i.test(s)
        || /^\d+\.\d+\.\d+\.\d+/.test(s)
        || /^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(s)
        || /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})/.test(s);
}

/** "https://www.example.com/a/b?c" → "example.com/a/b?c" (for display). */
export function displayUrl(url: string): string {
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
}

/** 0 = no match; higher is better. Host / title prefix beats a substring anywhere. */
export function matchScore(input: string, item: Titled): number {
    const q = input.trim().toLowerCase();
    if (!q) return 0;
    const url = displayUrl(item.url).toLowerCase();
    const title = (item.title || '').toLowerCase();
    if (url.startsWith(q)) return 4;
    if (title.startsWith(q)) return 3;
    if (title.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    if (url.includes(q) || title.includes(q)) return 1;
    return 0;
}

function best<T extends Titled>(input: string, items: T[], limit: number, skip: Set<string>): T[] {
    return items
        .map((item, i) => ({ item, i, score: matchScore(input, item) }))
        .filter((x) => x.score > 0 && !skip.has(x.item.url))
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, limit)
        .map((x) => x.item);
}

/**
 * @param input what the user typed
 * @param sources open tabs, bookmarks, history (history newest first)
 * @param resolve typed text → URL to open (a search URL when it is not an address)
 */
export function buildSuggestions(input: string, sources: SuggestionSources, resolve: (s: string) => string, limit = 8): Suggestion[] {
    const q = input.trim();
    if (!q) return [];
    const out: Suggestion[] = [];
    const seen = new Set<string>();

    const typed = resolve(q);
    out.push(looksLikeUrl(q)
        ? { kind: 'url', label: q, url: typed, detail: 'Go to address' }
        : { kind: 'search', label: q, url: typed, detail: 'Search the web' });
    seen.add(typed);

    const tabs = sources.tabs.filter((t) => !t.isAgentTab && !t.private && t.id !== sources.activeTabId && t.url !== 'bucks://newtab');
    for (const t of best(q, tabs.map((t) => ({ ...t, title: t.customTitle || t.title })), MAX.tab, seen)) {
        out.push({ kind: 'tab', label: t.title || displayUrl(t.url), url: t.url, detail: displayUrl(t.url), tabId: t.id });
        seen.add(t.url);
    }
    for (const b of best(q, sources.bookmarks, MAX.bookmark, seen)) {
        out.push({ kind: 'bookmark', label: b.title || displayUrl(b.url), url: b.url, detail: displayUrl(b.url) });
        seen.add(b.url);
    }
    for (const h of best(q, sources.history, MAX.history, seen)) {
        out.push({ kind: 'history', label: h.title || displayUrl(h.url), url: h.url, detail: displayUrl(h.url) });
        seen.add(h.url);
    }
    return out.slice(0, limit);
}

export type SecurityKind = 'secure' | 'ipfs' | 'insecure' | 'file' | 'internal' | 'other';

/** What the omnibox's left icon says about the active page. */
export function securityKind(url: string | undefined | null): SecurityKind {
    const u = String(url ?? '');
    if (!u || u.startsWith('bucks://')) return 'internal';
    if (/^https:/i.test(u)) return 'secure';
    if (/^(ipfs|ipns):/i.test(u)) return 'ipfs';
    if (/^http:/i.test(u)) return 'insecure';
    if (/^file:/i.test(u)) return 'file';
    return 'other';
}
