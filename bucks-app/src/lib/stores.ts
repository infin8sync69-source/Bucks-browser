import { writable, derived } from 'svelte/store';
import { goto } from '$app/navigation';

export interface Tab {
    id: string;
    url: string;
    title: string;
    type: 'internal' | 'external' | 'newtab';
    active: boolean;
    isLoading?: boolean;
    isAgentTab?: boolean;
    parentTabId?: string;
}

function routeTo(url: string) {
    if (typeof window === 'undefined') return;

    // Internal routing
    if (url === 'bucks://newtab') goto('/');
    else if (url.startsWith('bucks://')) {
        const path = url.replace('bucks://', '/');
        goto(path);
    }
}

function processUrl(url: string) {
    const isNewTab = url === 'bucks://newtab';
    const isInternal = url.startsWith('bucks://');
    const isExternal = !isInternal && (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(url) || (/^[\w-]+(\.[\w-]+)+/.test(url) && !url.includes(' ')));

    const title = isNewTab ? 'Bucks' : isInternal ? url.replace('bucks://', '').charAt(0).toUpperCase() + url.replace('bucks://', '').slice(1) : 'Loading...';
    const type: Tab['type'] = isNewTab ? 'newtab' : isInternal ? 'internal' : isExternal ? 'external' : 'internal';

    return { title, type, isExternal };
}

function createBrowserStore() {
    const { subscribe, set, update } = writable<{
        tabs: Tab[];
        activeTabId: string | null;
        favorites: { url: string; title: string }[];
    }>({
        tabs: [{
            id: 'initial_tab',
            url: 'bucks://newtab',
            title: 'Bucks',
            type: 'newtab',
            active: true
        }],
        activeTabId: 'initial_tab',
        favorites: [
            { url: 'https://google.com', title: 'Google' },
            { url: 'https://github.com', title: 'GitHub' },
            { url: 'https://youtube.com', title: 'YouTube' }
        ]
    });

    return {
        subscribe,
        set,
        update,
        createTab: (url: string = 'bucks://newtab', options: { isAgentTab?: boolean, parentTabId?: string } = {}) => {
            update(state => {
                const id = Math.random().toString(36).substring(7);
                const { title, type, isExternal } = processUrl(url);

                const newTab: Tab = {
                    id,
                    url,
                    title,
                    type,
                    active: !options.isAgentTab,
                    isLoading: isExternal,
                    isAgentTab: options.isAgentTab,
                    parentTabId: options.parentTabId
                };

                const newTabs = options.isAgentTab
                    ? state.tabs.concat(newTab)
                    : state.tabs.map(t => ({ ...t, active: false })).concat(newTab);

                const activeTabId = options.isAgentTab ? state.activeTabId : id;

                if (!isExternal && !options.isAgentTab) routeTo(url);

                return { ...state, tabs: newTabs, activeTabId };
            });
        },
        createOrFocusTab: (url: string) => {
            update(state => {
                const existingIndex = state.tabs.findIndex(t => t.url === url);
                if (existingIndex !== -1) {
                    const existing = state.tabs[existingIndex];
                    const newTabs = state.tabs.map(t => ({ ...t, active: t.id === existing.id }));
                    if (!processUrl(url).isExternal) routeTo(url);
                    return { ...state, tabs: newTabs, activeTabId: existing.id };
                }

                // Create new
                const id = Math.random().toString(36).substring(7);
                const { title, type, isExternal } = processUrl(url);

                const newTab: Tab = {
                    id,
                    url,
                    title,
                    type,
                    active: true,
                    isLoading: isExternal
                };

                const newTabs = state.tabs.map(t => ({ ...t, active: false })).concat(newTab);

                if (!isExternal) routeTo(url);
                return { ...state, tabs: newTabs, activeTabId: id };
            });
        },
        closeTab: (id: string) => {
            update(state => {
                const filtered = state.tabs.filter(t => t.id !== id);
                let newActiveId = state.activeTabId;

                if (state.activeTabId === id) {
                    if (filtered.length > 0) {
                        const last = filtered[filtered.length - 1];
                        last.active = true;
                        newActiveId = last.id;
                        routeTo(last.url);
                    } else {
                        newActiveId = null;
                        routeTo('bucks://newtab');
                    }
                }

                // Keep at least one tab open
                if (filtered.length === 0) {
                    const initialId = Math.random().toString(36).substring(7);
                    return {
                        ...state,
                        tabs: [{ id: initialId, url: 'bucks://newtab', title: 'Bucks', type: 'newtab', active: true }],
                        activeTabId: initialId
                    };
                }

                return { ...state, tabs: filtered, activeTabId: newActiveId };
            });
        },
        setActiveTab: (id: string) => {
            update(state => {
                const tabIndex = state.tabs.findIndex(t => t.id === id);
                if (tabIndex === -1) return state;

                const tab = state.tabs[tabIndex];
                const newTabs = state.tabs.map(t => ({ ...t, active: t.id === id }));

                if (tab.type !== 'external') {
                    routeTo(tab.url);
                }

                return { ...state, tabs: newTabs, activeTabId: id };
            });
        },
        navigateActiveTab: (url: string) => {
            update(state => {
                if (!state.activeTabId) return state;

                const { title, type, isExternal } = processUrl(url);

                const newTabs = state.tabs.map(t => t.id === state.activeTabId ? {
                    ...t,
                    url,
                    type,
                    title,
                    isLoading: isExternal
                } as Tab : t);

                if (!isExternal) routeTo(url);

                return { ...state, tabs: newTabs };
            });
        },
        updateTab: (id: string, updates: Partial<Tab>) => {
            update(state => ({
                ...state,
                tabs: state.tabs.map(t => t.id === id ? { ...t, ...updates } : t)
            }));
        },
        goBack: () => {
            if (typeof window !== 'undefined') window.history.back();
        },
        goForward: () => {
            if (typeof window !== 'undefined') window.history.forward();
        },
        refresh: () => {
            update(state => {
                const tab = state.tabs.find(t => t.id === state.activeTabId);
                if (tab && tab.type === 'external') {
                    // Quick iframe reload hack by replacing the URL temp
                    const url = tab.url;
                    state.tabs = state.tabs.map(t => t.id === tab.id ? { ...t, url: 'about:blank' } : t);
                    setTimeout(() => {
                        browserStore.updateTab(tab.id, { url });
                    }, 50);
                } else {
                    if (typeof window !== 'undefined') window.location.reload();
                }
                return state;
            });
        },
        addFavorite: (url: string, title: string) => {
            update(state => ({
                ...state,
                favorites: [...state.favorites, { url, title }]
            }));
        },
        removeFavorite: (url: string) => {
            update(state => ({
                ...state,
                favorites: state.favorites.filter(f => f.url !== url)
            }));
        }
    };
}

export const browserStore = createBrowserStore();
export const activeTab = derived(browserStore, $store => $store.tabs.find(t => t.id === $store.activeTabId) || null);
export const isSwarmThinking = writable(false);
