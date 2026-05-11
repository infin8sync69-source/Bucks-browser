import { writable, derived, get } from 'svelte/store';
import { goto } from '$app/navigation';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Tab {
    id: string;
    url: string;
    title: string;
    type: 'internal' | 'external' | 'newtab';
    active: boolean;
    isLoading?: boolean;
    isAgentTab?: boolean;
    parentTabId?: string;
    historyBack: string[];
    historyForward: string[];
}

export interface Bookmark {
    id: string;
    url: string;
    title: string;
    addedAt: number;
}

export interface HistoryEntry {
    url: string;
    title: string;
    visitedAt: number;
}

interface BrowserState {
    tabs: Tab[];
    activeTabId: string | null;
    bookmarks: Bookmark[];
    history: HistoryEntry[];
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'bucks_browser_v2';
const MAX_HISTORY = 500;

function loadState(): Partial<BrowserState> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const saved = JSON.parse(raw) as Partial<BrowserState>;
        // Reset loading state on restore
        if (saved.tabs) {
            saved.tabs = saved.tabs.map(t => ({ ...t, isLoading: false }));
        }
        return saved;
    } catch {
        return {};
    }
}

function saveState(state: BrowserState) {
    try {
        const toSave: BrowserState = {
            ...state,
            // Don't persist agent tabs
            tabs: state.tabs.filter(t => !t.isAgentTab),
            history: state.history.slice(0, MAX_HISTORY),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {}
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function routeTo(url: string) {
    if (typeof window === 'undefined') return;
    if (url === 'bucks://newtab') { goto('/'); return; }
    if (url.startsWith('bucks://')) { goto(url.replace('bucks://', '/')); return; }
    // External URL — ensure SvelteKit is on the root route where BrowserView renders
    goto('/');
}

function processUrl(url: string) {
    const isNewTab   = url === 'bucks://newtab';
    const isInternal = url.startsWith('bucks://');
    const isExternal = !isInternal && (
        /^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(url) ||
        (/^[\w-]+(\.[\w-]+)+/.test(url) && !url.includes(' '))
    );

    let title: string;
    if (isNewTab) {
        title = 'Bucks';
    } else if (isInternal) {
        const path = url.replace('bucks://', '');
        title = path.charAt(0).toUpperCase() + path.slice(1);
    } else if (/^ipfs:\/\//i.test(url)) {
        const cid = url.replace(/^ipfs:\/\//i, '').split('/')[0];
        title = cid.length > 16 ? `IPFS: ${cid.slice(0, 8)}…${cid.slice(-6)}` : `IPFS: ${cid}`;
    } else if (/^ipns:\/\//i.test(url)) {
        const name = url.replace(/^ipns:\/\//i, '').split('/')[0];
        title = `IPNS: ${name.length > 20 ? name.slice(0, 16) + '…' : name}`;
    } else {
        title = 'Loading...';
    }

    const type: Tab['type'] = isNewTab ? 'newtab' : isInternal ? 'internal' : isExternal ? 'external' : 'internal';
    return { title, type, isExternal };
}

function makeTab(url: string, opts: { isAgentTab?: boolean; parentTabId?: string } = {}): Tab {
    const { title, type, isExternal } = processUrl(url);
    return {
        id: Math.random().toString(36).slice(2, 9),
        url, title, type,
        active: !opts.isAgentTab,
        isLoading: isExternal,
        isAgentTab: opts.isAgentTab,
        parentTabId: opts.parentTabId,
        historyBack: [],
        historyForward: [],
    };
}

// ── Initial state ─────────────────────────────────────────────────────────────

function buildInitialState(): BrowserState {
    const saved = loadState();

    const tabs = (saved.tabs && saved.tabs.length > 0)
        ? saved.tabs
        : [makeTab('bucks://newtab')];

    // Ensure exactly one active tab
    const hasActive = tabs.some(t => t.active);
    if (!hasActive) tabs[tabs.length - 1].active = true;

    const activeTabId = saved.activeTabId && tabs.find(t => t.id === saved.activeTabId)
        ? saved.activeTabId
        : tabs.find(t => t.active)?.id ?? tabs[0].id;

    return {
        tabs,
        activeTabId,
        bookmarks: saved.bookmarks ?? [
            { id: '1', url: 'https://google.com',  title: 'Google',  addedAt: Date.now() },
            { id: '2', url: 'https://github.com',  title: 'GitHub',  addedAt: Date.now() },
            { id: '3', url: 'https://youtube.com', title: 'YouTube', addedAt: Date.now() },
        ],
        history: saved.history ?? [],
    };
}

// ── Store ─────────────────────────────────────────────────────────────────────

function createBrowserStore() {
    const { subscribe, set, update } = writable<BrowserState>(buildInitialState());

    function persist(state: BrowserState) {
        saveState(state);
        return state;
    }

    function pushHistory(state: BrowserState, url: string, title: string) {
        if (url === 'bucks://newtab') return state;
        const entry: HistoryEntry = { url, title, visitedAt: Date.now() };
        return {
            ...state,
            history: [entry, ...state.history.filter(h => h.url !== url)].slice(0, MAX_HISTORY),
        };
    }

    const store = {
        subscribe,
        set,
        update,

        createTab(url = 'bucks://newtab', opts: { isAgentTab?: boolean; parentTabId?: string } = {}) {
            update(s => {
                const tab = makeTab(url, opts);
                const tabs = opts.isAgentTab
                    ? [...s.tabs, tab]
                    : [...s.tabs.map(t => ({ ...t, active: false })), tab];
                const activeTabId = opts.isAgentTab ? s.activeTabId : tab.id;
                if (!tab.isAgentTab && !processUrl(url).isExternal) routeTo(url);
                return persist({ ...s, tabs, activeTabId });
            });
        },

        createOrFocusTab(url: string) {
            update(s => {
                const existing = s.tabs.find(t => t.url === url);
                if (existing) {
                    const tabs = s.tabs.map(t => ({ ...t, active: t.id === existing.id }));
                    if (!processUrl(url).isExternal) routeTo(url);
                    return persist({ ...s, tabs, activeTabId: existing.id });
                }
                const tab = makeTab(url);
                const tabs = [...s.tabs.map(t => ({ ...t, active: false })), tab];
                if (!processUrl(url).isExternal) routeTo(url);
                return persist({ ...s, tabs, activeTabId: tab.id });
            });
        },

        closeTab(id: string) {
            update(s => {
                const filtered = s.tabs.filter(t => t.id !== id);
                if (filtered.length === 0) {
                    const tab = makeTab('bucks://newtab');
                    routeTo('bucks://newtab');
                    return persist({ ...s, tabs: [{ ...tab, active: true }], activeTabId: tab.id });
                }
                let activeTabId = s.activeTabId;
                if (s.activeTabId === id) {
                    const last = filtered[filtered.length - 1];
                    last.active = true;
                    activeTabId = last.id;
                    routeTo(last.url);
                }
                return persist({ ...s, tabs: filtered, activeTabId });
            });
        },

        setActiveTab(id: string) {
            update(s => {
                const tab = s.tabs.find(t => t.id === id);
                if (!tab) return s;
                const tabs = s.tabs.map(t => ({ ...t, active: t.id === id }));
                routeTo(tab.url); // always — external tabs snap back to '/'
                return persist({ ...s, tabs, activeTabId: id });
            });
        },

        navigateActiveTab(url: string) {
            update(s => {
                if (!s.activeTabId) return s;
                const { title, type, isExternal } = processUrl(url);
                const tabs = s.tabs.map(t => {
                    if (t.id !== s.activeTabId) return t;
                    return {
                        ...t,
                        url, type, title,
                        isLoading: isExternal,
                        historyBack: t.url !== url ? [...t.historyBack, t.url] : t.historyBack,
                        historyForward: [],
                    } as Tab;
                });
                routeTo(url); // always — handles both internal and external routing
                let ns = { ...s, tabs };
                ns = pushHistory(ns, url, title);
                return persist(ns);
            });
        },

        updateTab(id: string, updates: Partial<Tab>) {
            update(s => {
                const tabs = s.tabs.map(t => t.id === id ? { ...t, ...updates } : t);
                // If title updated on external page, record in history
                let ns = { ...s, tabs };
                if (updates.title && updates.url) {
                    ns = pushHistory(ns, updates.url, updates.title);
                }
                return persist(ns);
            });
        },

        goBack() {
            update(s => {
                const tab = s.tabs.find(t => t.id === s.activeTabId);
                if (!tab || tab.historyBack.length === 0) return s;
                const prevUrl = tab.historyBack[tab.historyBack.length - 1];
                const { title, type, isExternal } = processUrl(prevUrl);
                const tabs = s.tabs.map(t => t.id === tab.id ? {
                    ...t,
                    url: prevUrl, title, type, isLoading: isExternal,
                    historyBack: t.historyBack.slice(0, -1),
                    historyForward: [t.url, ...t.historyForward],
                } as Tab : t);
                routeTo(prevUrl); // always
                return persist({ ...s, tabs });
            });
        },

        goForward() {
            update(s => {
                const tab = s.tabs.find(t => t.id === s.activeTabId);
                if (!tab || tab.historyForward.length === 0) return s;
                const nextUrl = tab.historyForward[0];
                const { title, type, isExternal } = processUrl(nextUrl);
                const tabs = s.tabs.map(t => t.id === tab.id ? {
                    ...t,
                    url: nextUrl, title, type, isLoading: isExternal,
                    historyBack: [...t.historyBack, t.url],
                    historyForward: t.historyForward.slice(1),
                } as Tab : t);
                routeTo(nextUrl); // always
                return persist({ ...s, tabs });
            });
        },

        refresh() {
            update(s => {
                const tab = s.tabs.find(t => t.id === s.activeTabId);
                if (tab?.type === 'external') {
                    const url = tab.url;
                    const tabs = s.tabs.map(t => t.id === tab.id ? { ...t, url: '', isLoading: true } : t);
                    setTimeout(() => store.updateTab(tab.id, { url, isLoading: false }), 80);
                    return { ...s, tabs };
                }
                if (typeof window !== 'undefined') window.location.reload();
                return s;
            });
        },

        // ── Bookmarks ─────────────────────────────────────────────────────────

        addBookmark(url: string, title: string) {
            update(s => {
                if (s.bookmarks.some(b => b.url === url)) return s;
                const bookmark: Bookmark = { id: Date.now().toString(), url, title, addedAt: Date.now() };
                return persist({ ...s, bookmarks: [bookmark, ...s.bookmarks] });
            });
        },

        removeBookmark(id: string) {
            update(s => persist({ ...s, bookmarks: s.bookmarks.filter(b => b.id !== id) }));
        },

        updateBookmark(id: string, changes: Partial<{ title: string; url: string }>) {
            update(s => persist({
                ...s,
                bookmarks: s.bookmarks.map(b => b.id === id ? { ...b, ...changes } : b)
            }));
        },

        clearHistory() {
            update(s => persist({ ...s, history: [] }));
        },

        removeHistoryEntry(url: string) {
            update(s => persist({ ...s, history: s.history.filter(h => h.url !== url) }));
        },

        // Keep backward compat for any code that used addFavorite/removeFavorite
        addFavorite(url: string, title: string) { store.addBookmark(url, title); },
        removeFavorite(url: string) {
            update(s => persist({ ...s, bookmarks: s.bookmarks.filter(b => b.url !== url) }));
        },
    };

    return store;
}

export const browserStore = createBrowserStore();
export const activeTab    = derived(browserStore, $s => $s.tabs.find(t => t.id === $s.activeTabId) || null);
export const isSwarmThinking = writable(false);
