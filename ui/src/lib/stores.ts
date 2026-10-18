import { writable, derived, get } from 'svelte/store';
import { goto, invalidateAll } from '$app/navigation';
import { bucks, type TabError, type TabState, type OpenRequest } from './bridge';
import { requestFocusOmnibox, toggleChat, openFindBar } from './uiState';

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
    /** Favicon URL reported by the page (external tabs). */
    favicon?: string | null;
    /** Chromium's own back/forward availability for the tab's web view (external tabs). */
    canGoBack?: boolean;
    canGoForward?: boolean;
    /** Last main-frame load error; cleared when a new load starts. Never persisted. */
    error?: TabError | null;
    /** True once the main process holds a web view for this tab. Never persisted. */
    viewCreated?: boolean;
    /** Pinned tabs sit first in the strip, show only their icon and survive "close others". */
    pinned?: boolean;
    /** Name the user gave the tab; shown instead of the page title. */
    customTitle?: string;
    /** Colour label (one of TAB_COLORS). */
    color?: TabColor | null;
    /** Space the tab belongs to. */
    spaceId?: string;
    /** In-memory private session: never persisted, never in history. */
    private?: boolean;
    /** Audio muted by the user (reported back by the main process). */
    muted?: boolean;
    audible?: boolean;
    /** Page zoom in percent (reported back by the main process). */
    zoom?: number;
}

export const TAB_COLORS = ['blue', 'violet', 'emerald', 'amber', 'rose', 'cyan', 'slate'] as const;
export type TabColor = (typeof TAB_COLORS)[number];

/** A Space groups tabs (work, personal, a project); the tab strip shows one Space at a time. */
export interface Space {
    id: string;
    name: string;
    color: TabColor;
}

export interface ClosedTab {
    url: string;
    title: string;
    spaceId?: string;
    index: number;
    pinned?: boolean;
    customTitle?: string;
    color?: TabColor | null;
}

export const DEFAULT_SPACE: Space = { id: 'default', name: 'Personal', color: 'blue' };
const MAX_CLOSED_TABS = 25;

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
    spaces: Space[];
    activeSpaceId: string;
    /** Last active tab of each space, so switching back returns to it. */
    spaceActiveTab: Record<string, string>;
    /** Most recently closed tabs first (private tabs are never kept). */
    closedTabs: ClosedTab[];
}

export interface CreateTabOptions {
    isAgentTab?: boolean;
    parentTabId?: string;
    /** Create the tab (and start loading it) without switching to it. */
    background?: boolean;
    /** Open in the in-memory private session. */
    private?: boolean;
    /** Space for the new tab (default: the active one). */
    spaceId?: string;
    /** Insert at this index in the tab list (default: at the end). */
    index?: number;
    pinned?: boolean;
    customTitle?: string;
    color?: TabColor | null;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'bucks_browser_v2';
const MAX_HISTORY = 500;

/** Reset every field that only makes sense while the process is alive. */
function transientReset(t: Tab): Tab {
    return {
        ...t,
        isLoading: false,
        error: null,
        viewCreated: false,
        canGoBack: false,
        canGoForward: false,
    };
}

function loadState(): Partial<BrowserState> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const saved = JSON.parse(raw) as Partial<BrowserState>;
        if (saved.tabs) saved.tabs = saved.tabs.map(transientReset);
        return saved;
    } catch {
        return {};
    }
}

function saveState(state: BrowserState) {
    try {
        const toSave: BrowserState = {
            ...state,
            // Agent tabs, private tabs and transient fields (isLoading / error / viewCreated / canGo* /
            // audio / zoom) are not persisted.
            tabs: state.tabs
                .filter((t) => !t.isAgentTab && !t.private)
                .map((t) => {
                    const { isLoading, error, viewCreated, canGoBack, canGoForward, muted, audible, zoom, ...rest } = t;
                    void isLoading; void error; void viewCreated; void canGoBack; void canGoForward; void muted; void audible; void zoom;
                    return rest as Tab;
                }),
            activeTabId: state.tabs.find((t) => t.id === state.activeTabId && !t.private) ? state.activeTabId : null,
            history: state.history.slice(0, MAX_HISTORY),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {
        /* storage unavailable or full — the session simply is not restored */
    }
}

// ── URL helpers ───────────────────────────────────────────────────────────────

const EXTERNAL_SCHEME = /^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i;
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+/;

/** Bare domains ("example.com/x") get an https:// prefix; everything else is returned unchanged. */
export function normalizeExternalUrl(url: string): string {
    if (!url.startsWith('bucks://') && !EXTERNAL_SCHEME.test(url) && BARE_DOMAIN.test(url) && !url.includes(' ')) {
        return `https://${url}`;
    }
    return url;
}

function routeTo(url: string) {
    if (typeof window === 'undefined') return;
    // keepFocus: SvelteKit would otherwise blur the omnibox after every navigation.
    const opts = { keepFocus: true };
    if (url === 'bucks://newtab') { void goto('/', opts); return; }
    if (url.startsWith('bucks://')) { void goto(url.replace('bucks://', '/'), opts); return; }
    // External URL — the placeholder (ContentArea) lives in the layout, any route will do.
    void goto('/', opts);
}

function processUrl(url: string) {
    const isNewTab   = url === 'bucks://newtab';
    const isInternal = url.startsWith('bucks://');
    const isExternal = !isInternal && (
        EXTERNAL_SCHEME.test(url) ||
        (BARE_DOMAIN.test(url) && !url.includes(' '))
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

function newTabId(): string {
    return (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 36);
}

function makeTab(rawUrl: string, opts: CreateTabOptions = {}): Tab {
    const url = normalizeExternalUrl(rawUrl);
    const { title, type, isExternal } = processUrl(url);
    const inactive = opts.isAgentTab || opts.background;
    return {
        id: newTabId(),
        url, title, type,
        active: !inactive,
        isLoading: isExternal,
        isAgentTab: opts.isAgentTab,
        parentTabId: opts.parentTabId,
        spaceId: opts.spaceId ?? DEFAULT_SPACE.id,
        private: opts.private === true || undefined,
        pinned: opts.pinned || undefined,
        customTitle: opts.customTitle || undefined,
        color: opts.color ?? null,
        historyBack: [],
        historyForward: [],
        favicon: null,
        canGoBack: false,
        canGoForward: false,
        error: null,
        viewCreated: false,
    };
}

function errorMessage(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

/** Closed-tab stack after closing `tab` (private, agent and blank tabs are not kept). */
function rememberClosed(state: BrowserState, tab: Tab): ClosedTab[] {
    if (tab.private || tab.isAgentTab || tab.url === 'bucks://newtab') return state.closedTabs;
    const entry: ClosedTab = {
        url: tab.url,
        title: tab.customTitle || tab.title,
        spaceId: tab.spaceId,
        index: state.tabs.findIndex((t) => t.id === tab.id),
        pinned: tab.pinned,
        customTitle: tab.customTitle,
        color: tab.color ?? null,
    };
    return [entry, ...state.closedTabs].slice(0, MAX_CLOSED_TABS);
}

function newSpaceId(): string {
    return `space-${newTabId().slice(0, 8)}`;
}

/** Tabs shown in the strip for a space: pinned first, then the rest, in list order; no agent tabs. */
export function stripTabs(tabs: Tab[], spaceId: string): Tab[] {
    const inSpace = tabs.filter((t) => t.spaceId === spaceId && !t.isAgentTab);
    return [...inSpace.filter((t) => t.pinned), ...inSpace.filter((t) => !t.pinned)];
}

// ── Initial state ─────────────────────────────────────────────────────────────

function buildInitialState(): BrowserState {
    const saved = loadState();

    const spaces = saved.spaces && saved.spaces.length > 0 ? saved.spaces : [DEFAULT_SPACE];
    const spaceIds = new Set(spaces.map((sp) => sp.id));
    const activeSpaceId = saved.activeSpaceId && spaceIds.has(saved.activeSpaceId) ? saved.activeSpaceId : spaces[0].id;

    const tabs = (saved.tabs && saved.tabs.length > 0)
        ? saved.tabs.map((t) => ({ ...t, spaceId: t.spaceId && spaceIds.has(t.spaceId) ? t.spaceId : spaces[0].id }))
        : [makeTab('bucks://newtab', { spaceId: activeSpaceId })];

    // Ensure exactly one active tab
    const hasActive = tabs.some(t => t.active);
    if (!hasActive) tabs[tabs.length - 1].active = true;

    const activeTabId = saved.activeTabId && tabs.find(t => t.id === saved.activeTabId)
        ? saved.activeTabId
        : tabs.find(t => t.active)?.id ?? tabs[0].id;
    for (const t of tabs) t.active = t.id === activeTabId;

    return {
        tabs,
        activeTabId,
        spaces,
        activeSpaceId: tabs.find((t) => t.id === activeTabId)?.spaceId ?? activeSpaceId,
        spaceActiveTab: saved.spaceActiveTab ?? {},
        closedTabs: saved.closedTabs ?? [],
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

    let initialised = false;
    let unsubscribers: Array<() => void> = [];

    function persist(state: BrowserState) {
        saveState(state);
        return state;
    }

    function pushHistory(state: BrowserState, url: string, title: string, tab?: Tab): BrowserState {
        if (url === 'bucks://newtab' || tab?.private) return state;
        const entry: HistoryEntry = { url, title, visitedAt: Date.now() };
        return {
            ...state,
            history: [entry, ...state.history.filter(h => h.url !== url)].slice(0, MAX_HISTORY),
        };
    }

    function tabById(id: string): Tab | undefined {
        return get({ subscribe }).tabs.find((t) => t.id === id);
    }

    function activeTabNow(): Tab | undefined {
        const s = get({ subscribe });
        return s.tabs.find((t) => t.id === s.activeTabId);
    }

    /** Patch one tab without touching anything else (no persistence of transient fields happens in saveState). */
    function patchTab(id: string, patch: Partial<Tab>) {
        update((s) => persist({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
    }

    function failTab(id: string, url: string, e: unknown) {
        patchTab(id, { isLoading: false, error: { code: -1, description: errorMessage(e), url } });
    }

    // ── main-process view management ─────────────────────────────────────────────

    /** Create the web view for an external tab if the main process does not have one yet. */
    async function ensureView(tab: Tab): Promise<void> {
        if (tab.type !== 'external' || tab.viewCreated) return;
        patchTab(tab.id, { viewCreated: true, isLoading: true, error: null });
        try {
            await bucks.tabs.create(tab.id, tab.url, { private: tab.private === true });
        } catch (e) {
            patchTab(tab.id, { viewCreated: false });
            failTab(tab.id, tab.url, e);
        }
    }

    /** Close the main-process view of a tab (the tab itself stays). */
    function dropView(tab: Tab | undefined) {
        if (!tab?.viewCreated) return;
        patchTab(tab.id, { viewCreated: false, canGoBack: false, canGoForward: false, isLoading: false, error: null });
        bucks.tabs.close(tab.id).catch((e) => console.warn('[tabs] close failed:', errorMessage(e)));
    }

    let syncSeq = 0;
    /**
     * Make the main process show exactly the active tab: its view for an external tab (created on
     * first use), nothing for internal / newtab tabs.
     */
    async function syncActiveView(): Promise<void> {
        const seq = ++syncSeq;
        const tab = activeTabNow();
        try {
            if (!tab || tab.type !== 'external') {
                await bucks.tabs.activate(null);
                return;
            }
            await ensureView(tab);
            if (seq !== syncSeq) return; // a newer activation superseded this one
            const current = tabById(tab.id);
            if (!current?.viewCreated) return;
            await bucks.tabs.activate(tab.id);
        } catch (e) {
            console.warn('[tabs] activate failed:', errorMessage(e));
        }
    }

    // ── store ────────────────────────────────────────────────────────────────────

    const store = {
        subscribe,
        set,
        update,

        /**
         * Wire the store to the main process. Call once (from +layout.svelte onMount); returns a
         * teardown function. Restores the view for the active external tab.
         */
        init(): () => void {
            if (initialised) return () => {};
            initialised = true;

            unsubscribers.push(
                bucks.tabs.onUpdated((state) => store.applyTabState(state)),
                bucks.tabs.onOpenRequest((req) => store.handleOpenRequest(req)),
                bucks.tabs.onClosed(({ id }) => store.closeTab(id, { fromMain: true })),
                bucks.app.onShortcut(({ action }) => store.handleShortcut(action)),
            );
            // Links the OS handed to Bucks (default browser, "open with") arrive once this is wired up.
            bucks.app.chromeReady().catch(() => {});

            const active = activeTabNow();
            if (active) routeTo(active.url);
            void syncActiveView();

            return () => {
                for (const off of unsubscribers) off();
                unsubscribers = [];
                initialised = false;
            };
        },

        /** Apply a TabState pushed by the main process. */
        applyTabState(state: TabState) {
            const tab = tabById(state.id);
            // Late events for tabs that were closed or turned into internal pages are ignored.
            if (!tab || tab.type !== 'external') return;
            const url = state.url || tab.url;
            const title = state.title || (url === tab.url ? tab.title : processUrl(url).title);
            const changed = url !== tab.url || title !== tab.title;
            update((s) => {
                const tabs = s.tabs.map((t) =>
                    t.id === state.id
                        ? {
                              ...t,
                              url, title,
                              favicon: state.favicon,
                              isLoading: state.isLoading,
                              canGoBack: state.canGoBack,
                              canGoForward: state.canGoForward,
                              error: state.error,
                              muted: state.muted,
                              audible: state.audible,
                              zoom: state.zoom,
                          }
                        : t,
                );
                let next: BrowserState = { ...s, tabs };
                if (changed && state.title && !state.error && !tab.isAgentTab) next = pushHistory(next, url, state.title, tab);
                return persist(next);
            });
        },

        /** window.open / target=_blank / middle-click / bucks:// links coming from web content. */
        handleOpenRequest(req: OpenRequest) {
            const url = req.url;
            if (!url) return;
            if (req.disposition === 'current-tab' && req.openerId && tabById(req.openerId)) {
                const opener = tabById(req.openerId)!;
                if (opener.id === get({ subscribe }).activeTabId) store.navigateActiveTab(url);
                else store.navigateTab(opener.id, url);
                return;
            }
            // Links from a private tab stay private.
            const opener = req.openerId ? tabById(req.openerId) : undefined;
            store.createTab(url, {
                background: req.disposition === 'background-tab',
                parentTabId: req.openerId ?? undefined,
                private: opener?.private === true,
                spaceId: opener?.spaceId,
            });
        },

        /** Map a native-menu / accelerator action to a store action. */
        handleShortcut(action: string) {
            const s = get({ subscribe });
            switch (action) {
                case 'new-tab': store.createTab(); requestFocusOmnibox(); break;
                case 'close-tab': if (s.activeTabId) store.closeTab(s.activeTabId); break;
                case 'focus-omnibox': requestFocusOmnibox(); break;
                case 'reload': store.refresh(); break;
                case 'back': store.goBack(); break;
                case 'forward': store.goForward(); break;
                case 'next-tab': store.cycleTab(1); break;
                case 'prev-tab': store.cycleTab(-1); break;
                case 'open-settings': store.createOrFocusTab('bucks://settings'); break;
                case 'open-downloads': store.createOrFocusTab('bucks://downloads'); break;
                case 'open-ipfs': store.createOrFocusTab('bucks://ipfs'); break;
                case 'open-wallet': store.createOrFocusTab('bucks://wallet'); break;
                case 'toggle-agent': toggleChat(); break;
                case 'new-private-tab': store.createTab('bucks://newtab', { private: true }); requestFocusOmnibox(); break;
                case 'reopen-closed-tab': store.reopenClosedTab(); break;
                case 'find': if (activeTabNow()?.type === 'external') openFindBar(); break;
                case 'print': void store.printActive(); break;
                case 'save-pdf': void store.savePdfActive(); break;
                default: break; // zoom-* / toggle-devtools are handled by the main process
            }
        },

        /** Activate the next (+1) / previous (-1) tab of the current space, wrapping around. */
        cycleTab(direction: 1 | -1) {
            const s = get({ subscribe });
            const visible = s.tabs.filter((t) => t.spaceId === s.activeSpaceId && !t.isAgentTab);
            if (visible.length < 2) return;
            const idx = visible.findIndex((t) => t.id === s.activeTabId);
            const next = visible[(idx + direction + visible.length) % visible.length];
            store.setActiveTab(next.id);
        },

        createTab(url = 'bucks://newtab', opts: CreateTabOptions = {}) {
            const current = get({ subscribe });
            const tab = makeTab(url, { ...opts, spaceId: opts.spaceId ?? current.activeSpaceId });
            const foreground = !opts.isAgentTab && !opts.background;
            update((s) => {
                const base = foreground ? s.tabs.map((t) => ({ ...t, active: false })) : s.tabs;
                const at = Number.isInteger(opts.index) ? Math.max(0, Math.min(base.length, opts.index as number)) : base.length;
                const tabs = [...base.slice(0, at), tab, ...base.slice(at)];
                return persist({
                    ...s,
                    tabs,
                    activeTabId: foreground ? tab.id : s.activeTabId,
                    activeSpaceId: foreground ? (tab.spaceId ?? s.activeSpaceId) : s.activeSpaceId,
                });
            });
            if (foreground) {
                if (tab.type !== 'external') routeTo(tab.url);
                void syncActiveView();
            } else if (tab.type === 'external') {
                // Background / agent tabs start loading right away, without being shown.
                void ensureView(tab);
            }
            return tab.id;
        },

        createOrFocusTab(url: string) {
            const s = get({ subscribe });
            const existing = s.tabs.find((t) => t.url === url && t.spaceId === s.activeSpaceId && !t.private)
                ?? s.tabs.find((t) => t.url === url && !t.private);
            if (existing) {
                store.setActiveTab(existing.id);
                return;
            }
            store.createTab(url);
        },

        closeTab(id: string, opts: { fromMain?: boolean } = {}) {
            const before = get({ subscribe });
            const closing = before.tabs.find((t) => t.id === id);
            if (!closing) return;
            if (closing.viewCreated && !opts.fromMain) {
                bucks.tabs.close(id).catch((e) => console.warn('[tabs] close failed:', errorMessage(e)));
            }
            const closedTabs = rememberClosed(before, closing);

            const filtered = before.tabs.filter((t) => t.id !== id);
            const spaceId = closing.spaceId ?? before.activeSpaceId;
            const sameSpace = filtered.filter((t) => t.spaceId === spaceId && !t.isAgentTab);
            const wasActive = before.activeTabId === id;
            if (wasActive && sameSpace.length === 0) {
                // Last tab of this space: the space keeps a fresh new-tab page.
                const tab = { ...makeTab('bucks://newtab', { spaceId }), active: true };
                update((s) => persist({ ...s, closedTabs, tabs: [...filtered.map((t) => ({ ...t, active: false })), tab], activeTabId: tab.id }));
                routeTo(tab.url);
                void syncActiveView();
                return;
            }

            let activeTabId = before.activeTabId;
            let tabs = filtered;
            if (wasActive) {
                // Prefer the neighbour in the same space that took the closed tab's slot.
                const spaceTabs = before.tabs.filter((t) => t.spaceId === spaceId && !t.isAgentTab);
                const idx = spaceTabs.findIndex((t) => t.id === id);
                const next = sameSpace[Math.min(idx, sameSpace.length - 1)];
                activeTabId = next.id;
                tabs = filtered.map((t) => ({ ...t, active: t.id === next.id }));
            }
            update((s) => persist({ ...s, closedTabs, tabs, activeTabId }));
            if (wasActive) {
                const next = tabs.find((t) => t.id === activeTabId)!;
                routeTo(next.url);
                void syncActiveView();
            }
        },

        setActiveTab(id: string) {
            const s = get({ subscribe });
            const tab = s.tabs.find((t) => t.id === id);
            if (!tab) return;
            const tabs = s.tabs.map((t) => ({ ...t, active: t.id === id }));
            const spaceId = tab.spaceId ?? s.activeSpaceId;
            update((cur) => persist({
                ...cur,
                tabs,
                activeTabId: id,
                activeSpaceId: spaceId,
                spaceActiveTab: tab.private ? cur.spaceActiveTab : { ...cur.spaceActiveTab, [spaceId]: id },
            }));
            routeTo(tab.url); // internal tabs show their route, external tabs snap back to '/'
            void syncActiveView();
        },

        /** Navigate the active tab to `url` (internal route or external page). */
        navigateActiveTab(url: string) {
            const s = get({ subscribe });
            if (s.activeTabId) store.navigateTab(s.activeTabId, url);
            else store.createTab(url);
        },

        /** Navigate any tab. Only the active tab changes the visible route / view. */
        navigateTab(id: string, rawUrl: string) {
            const s = get({ subscribe });
            const tab = s.tabs.find((t) => t.id === id);
            if (!tab) return;
            const url = normalizeExternalUrl(rawUrl);
            const { title, type, isExternal } = processUrl(url);
            const wasExternal = tab.type === 'external';
            const isActive = id === s.activeTabId;

            // Chromium keeps the history between external pages; the renderer's stack only
            // records hops into and out of internal routes.
            const pushBack = !(wasExternal && isExternal) && tab.url !== url;
            update((cur) => {
                const tabs = cur.tabs.map((t) =>
                    t.id !== id
                        ? t
                        : ({
                              ...t,
                              url, type, title,
                              isLoading: isExternal,
                              error: null,
                              favicon: isExternal ? t.favicon : null,
                              historyBack: pushBack ? [...t.historyBack, t.url] : t.historyBack,
                              historyForward: wasExternal && isExternal ? t.historyForward : [],
                          } as Tab),
                );
                let ns: BrowserState = { ...cur, tabs };
                if (!isExternal) ns = pushHistory(ns, url, title, tab);
                return persist(ns);
            });

            if (wasExternal && !isExternal) dropView(tab);
            if (isExternal) {
                if (tab.viewCreated && wasExternal) {
                    bucks.tabs.navigate(id, url).catch((e) => failTab(id, url, e));
                    if (isActive) void syncActiveView();
                } else if (isActive) {
                    void syncActiveView();
                } else {
                    void ensureView({ ...tab, url, type: 'external', viewCreated: false });
                }
            }
            if (isActive) {
                routeTo(url);
                if (!isExternal) void syncActiveView();
            }
        },

        updateTab(id: string, updates: Partial<Tab>) {
            update((s) => {
                const tabs = s.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t));
                let ns: BrowserState = { ...s, tabs };
                // If title updated on external page, record in history
                if (updates.title && updates.url) {
                    ns = pushHistory(ns, updates.url, updates.title, s.tabs.find((t) => t.id === id));
                }
                return persist(ns);
            });
        },

        goBack() {
            const tab = activeTabNow();
            if (!tab) return;
            if (tab.type === 'external' && tab.viewCreated && tab.canGoBack) {
                bucks.tabs.back(tab.id).catch((e) => console.warn('[tabs] back failed:', errorMessage(e)));
                return;
            }
            if (tab.historyBack.length === 0) return;
            const prevUrl = tab.historyBack[tab.historyBack.length - 1];
            const { title, type, isExternal } = processUrl(prevUrl);
            const wasExternal = tab.type === 'external';
            update((s) => persist({
                ...s,
                tabs: s.tabs.map((t) => t.id === tab.id ? {
                    ...t,
                    url: prevUrl, title, type, isLoading: isExternal, error: null,
                    historyBack: t.historyBack.slice(0, -1),
                    historyForward: [t.url, ...t.historyForward],
                } as Tab : t),
            }));
            store.afterHistoryHop(tab, prevUrl, wasExternal, isExternal);
        },

        goForward() {
            const tab = activeTabNow();
            if (!tab) return;
            if (tab.type === 'external' && tab.viewCreated && tab.canGoForward) {
                bucks.tabs.forward(tab.id).catch((e) => console.warn('[tabs] forward failed:', errorMessage(e)));
                return;
            }
            if (tab.historyForward.length === 0) return;
            const nextUrl = tab.historyForward[0];
            const { title, type, isExternal } = processUrl(nextUrl);
            const wasExternal = tab.type === 'external';
            update((s) => persist({
                ...s,
                tabs: s.tabs.map((t) => t.id === tab.id ? {
                    ...t,
                    url: nextUrl, title, type, isLoading: isExternal, error: null,
                    historyBack: [...t.historyBack, t.url],
                    historyForward: t.historyForward.slice(1),
                } as Tab : t),
            }));
            store.afterHistoryHop(tab, nextUrl, wasExternal, isExternal);
        },

        /** Shared tail of goBack/goForward when the renderer's own stack moved the tab. */
        afterHistoryHop(before: Tab, url: string, wasExternal: boolean, isExternal: boolean) {
            if (wasExternal && !isExternal) dropView(before);
            if (isExternal) {
                if (before.viewCreated && wasExternal) {
                    bucks.tabs.navigate(before.id, url).catch((e) => failTab(before.id, url, e));
                }
            }
            routeTo(url);
            void syncActiveView();
        },

        refresh() {
            const tab = activeTabNow();
            if (!tab) return;
            if (tab.type === 'external') {
                if (!tab.viewCreated) {
                    patchTab(tab.id, { error: null });
                    void syncActiveView();
                    return;
                }
                patchTab(tab.id, { isLoading: true, error: null });
                bucks.tabs.reload(tab.id).catch((e) => failTab(tab.id, tab.url, e));
                return;
            }
            void invalidateAll();
        },

        /** Forget everything: close every web view and reset tabs, bookmarks and history. */
        resetAll() {
            for (const t of get({ subscribe }).tabs) {
                if (t.viewCreated) {
                    bucks.tabs.close(t.id).catch((e) => console.warn('[tabs] close failed:', errorMessage(e)));
                }
            }
            try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
            set(persist(buildInitialState()));
            routeTo('bucks://newtab');
            void syncActiveView();
        },

        // ── Tab actions (context menu) ──────────────────────────────────────────

        /** Reopen the most recently closed tab, in its space and position. */
        reopenClosedTab() {
            const s = get({ subscribe });
            const [last, ...rest] = s.closedTabs;
            if (!last) return;
            update((cur) => persist({ ...cur, closedTabs: rest }));
            const spaceId = s.spaces.some((sp) => sp.id === last.spaceId) ? last.spaceId : s.activeSpaceId;
            store.createTab(last.url, { spaceId, index: last.index, pinned: last.pinned, customTitle: last.customTitle, color: last.color });
        },

        duplicateTab(id: string) {
            const s = get({ subscribe });
            const tab = s.tabs.find((t) => t.id === id);
            if (!tab) return;
            const index = s.tabs.findIndex((t) => t.id === id) + 1;
            store.createTab(tab.url, { spaceId: tab.spaceId, private: tab.private, index, customTitle: tab.customTitle, color: tab.color });
        },

        togglePin(id: string) {
            const tab = tabById(id);
            if (tab) patchTab(id, { pinned: !tab.pinned || undefined });
        },

        /** Give the tab a name of its own; an empty name goes back to the page title. */
        renameTab(id: string, name: string) {
            const trimmed = name.trim().slice(0, 80);
            patchTab(id, { customTitle: trimmed || undefined });
        },

        setTabColor(id: string, color: TabColor | null) {
            patchTab(id, { color });
        },

        setMuted(id: string, muted: boolean) {
            const tab = tabById(id);
            if (!tab) return;
            patchTab(id, { muted });
            if (tab.viewCreated) bucks.tabs.setMuted(id, muted).catch((e) => console.warn('[tabs] mute failed:', errorMessage(e)));
        },

        /** Close every other unpinned tab of the same space. */
        closeOtherTabs(id: string) {
            const s = get({ subscribe });
            const keep = s.tabs.find((t) => t.id === id);
            if (!keep) return;
            store.setActiveTab(id);
            for (const t of stripTabs(s.tabs, keep.spaceId ?? s.activeSpaceId)) {
                if (t.id !== id && !t.pinned) store.closeTab(t.id);
            }
        },

        /** Close the unpinned tabs after this one in the strip. */
        closeTabsToRight(id: string) {
            const s = get({ subscribe });
            const tab = s.tabs.find((t) => t.id === id);
            if (!tab) return;
            const strip = stripTabs(s.tabs, tab.spaceId ?? s.activeSpaceId);
            const at = strip.findIndex((t) => t.id === id);
            for (const t of strip.slice(at + 1)) if (!t.pinned) store.closeTab(t.id);
        },

        // ── Spaces ────────────────────────────────────────────────────────────

        createSpace(name: string, color: TabColor = 'violet'): string {
            const space: Space = { id: newSpaceId(), name: name.trim().slice(0, 40) || 'New space', color };
            update((s) => persist({ ...s, spaces: [...s.spaces, space] }));
            store.switchSpace(space.id);
            return space.id;
        },

        updateSpace(id: string, changes: Partial<Pick<Space, 'name' | 'color'>>) {
            update((s) => persist({
                ...s,
                spaces: s.spaces.map((sp) => sp.id === id
                    ? { ...sp, ...changes, name: (changes.name ?? sp.name).trim().slice(0, 40) || sp.name }
                    : sp),
            }));
        },

        /** Delete a space; its tabs move to the first remaining space. The last space cannot go. */
        deleteSpace(id: string) {
            const s = get({ subscribe });
            if (s.spaces.length < 2 || !s.spaces.some((sp) => sp.id === id)) return;
            const target = s.spaces.find((sp) => sp.id !== id)!;
            update((cur) => persist({
                ...cur,
                spaces: cur.spaces.filter((sp) => sp.id !== id),
                tabs: cur.tabs.map((t) => (t.spaceId === id ? { ...t, spaceId: target.id } : t)),
            }));
            if (s.activeSpaceId === id) store.switchSpace(target.id);
        },

        /** Show another space: its last active tab, or a new-tab page when it has none. */
        switchSpace(id: string) {
            const s = get({ subscribe });
            if (!s.spaces.some((sp) => sp.id === id)) return;
            const strip = stripTabs(s.tabs, id);
            const remembered = strip.find((t) => t.id === s.spaceActiveTab[id]);
            const target = remembered ?? strip[strip.length - 1];
            if (target) {
                store.setActiveTab(target.id);
                return;
            }
            update((cur) => persist({ ...cur, activeSpaceId: id }));
            store.createTab('bucks://newtab', { spaceId: id });
        },

        moveTabToSpace(tabId: string, spaceId: string) {
            const s = get({ subscribe });
            const tab = s.tabs.find((t) => t.id === tabId);
            if (!tab || tab.spaceId === spaceId || !s.spaces.some((sp) => sp.id === spaceId)) return;
            const wasActive = s.activeTabId === tabId;
            const remaining = stripTabs(s.tabs, tab.spaceId ?? s.activeSpaceId).filter((t) => t.id !== tabId);
            patchTab(tabId, { spaceId });
            if (!wasActive) return;
            // The moved tab leaves the visible strip: show a neighbour, or a fresh page.
            if (remaining.length) store.setActiveTab(remaining[remaining.length - 1].id);
            else store.createTab('bucks://newtab', { spaceId: tab.spaceId });
        },

        // ── Page actions ──────────────────────────────────────────────────────

        async printActive() {
            const tab = activeTabNow();
            if (tab?.type !== 'external' || !tab.viewCreated) return;
            try { await bucks.tabs.print(tab.id); } catch (e) { console.warn('[tabs] print failed:', errorMessage(e)); }
        },

        /** @returns the saved path, or null (cancelled / not a web page) */
        async savePdfActive(): Promise<string | null> {
            const tab = activeTabNow();
            if (tab?.type !== 'external' || !tab.viewCreated) return null;
            try { return (await bucks.tabs.printToPdf(tab.id)).path; } catch (e) { console.warn('[tabs] save as PDF failed:', errorMessage(e)); return null; }
        },

        zoomActive(action: 'in' | 'out' | 'reset') {
            const tab = activeTabNow();
            if (tab?.type !== 'external' || !tab.viewCreated) return;
            bucks.tabs.zoom(tab.id, action).then((zoom) => patchTab(tab.id, { zoom })).catch(() => {});
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

        clearClosedTabs() {
            update(s => persist({ ...s, closedTabs: [] }));
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
/** Tabs of the active space as the strip shows them (pinned first). */
export const visibleTabs  = derived(browserStore, $s => stripTabs($s.tabs, $s.activeSpaceId));
export const activeSpace  = derived(browserStore, $s => $s.spaces.find((sp) => sp.id === $s.activeSpaceId) ?? $s.spaces[0]);
export const isSwarmThinking = writable(false);
