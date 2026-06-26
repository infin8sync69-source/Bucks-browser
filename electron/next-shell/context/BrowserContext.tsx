"use client";

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';

export interface Tab {
    id: string;
    url: string;
    title: string;
    type: 'internal' | 'external' | 'newtab';
    active: boolean;
    isLoading?: boolean;
}

interface BrowserContextType {
    tabs: Tab[];
    activeTabId: string | null;
    createTab: (url?: string) => void;
    closeTab: (id: string) => void;
    setActiveTab: (id: string) => void;
    navigateActiveTab: (url: string) => void;
    updateTab: (id: string, updates: Partial<Tab>) => void;
    goBack: () => void;
    goForward: () => void;
    refresh: () => void;
}

const BrowserContext = createContext<BrowserContextType | undefined>(undefined);

export const BrowserProvider = ({ children }: { children: ReactNode }) => {
    const [tabs, setTabs] = useState<Tab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const router = useRouter();
    const pathname = usePathname();

    // Sync active tab with pathname for internal routes
    useEffect(() => {
        if (activeTabId) {
            const activeTab = tabs.find(t => t.id === activeTabId);
            if (activeTab && activeTab.type === 'internal' && activeTab.url !== pathname) {
                setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: pathname } : t));
            }
        }
    }, [pathname]);

    const createTab = (url: string = 'bucks://newtab') => {
        const id = Math.random().toString(36).substring(7);
        const isNewTab = url === 'bucks://newtab';
        const isChat = url.startsWith('bucks://chat');

        let isExternal = false;
        if (!isNewTab && !isChat) {
            isExternal = /^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(url) || (/^[\w-]+(\.[\w-]+)+/.test(url) && !url.includes(' '));
        }

        const newTab: Tab = {
            id,
            url,
            title: isNewTab ? 'New Tab' : isChat ? 'AI Chat' : 'Loading...',
            type: isNewTab || isChat ? 'internal' : isExternal ? 'external' : 'internal',
            active: true,
            isLoading: isExternal
        };

        setTabs(prev => prev.map(t => ({ ...t, active: false })).concat(newTab));
        setActiveTabId(id);

        if (!isExternal && !isNewTab) {
            if (isChat) {
                router.push(`/chat${url.substring('bucks://chat'.length)}`);
            } else {
                router.push(url);
            }
        }
    };

    const closeTab = (id: string) => {
        setTabs(prev => {
            const filtered = prev.filter(t => t.id !== id);
            if (activeTabId === id) {
                if (filtered.length > 0) {
                    const last = filtered[filtered.length - 1];
                    last.active = true;
                    setActiveTabId(last.id);
                    if (last.type === 'internal') router.push(last.url);
                } else {
                    setActiveTabId(null);
                    router.push('/');
                }
            }
            return filtered;
        });
    };

    const setActiveTab = (id: string) => {
        const tab = tabs.find(t => t.id === id);
        if (!tab) return;

        setTabs(prev => prev.map(t => ({ ...t, active: t.id === id })));
        setActiveTabId(id);

        if (tab.type === 'internal') {
            router.push(tab.url);
        }
    };

    const navigateActiveTab = (url: string) => {
        if (!activeTabId) return;
        const isChat = url.startsWith('bucks://chat');
        const isExternal = !isChat && (url.startsWith('http') || url.startsWith('ipfs://') || url.startsWith('ipns://'));
        const isNewTab = url === 'bucks://newtab';

        setTabs(prev => prev.map(t => t.id === activeTabId ? {
            ...t,
            url,
            type: isNewTab ? 'newtab' : isChat ? 'internal' : isExternal ? 'external' : 'internal',
            title: isNewTab ? 'New Tab' : isChat ? 'AI Chat' : t.title
        } : t));

        if (!isExternal && !isNewTab) {
            if (isChat) {
                router.push(`/chat${url.substring('bucks://chat'.length)}`);
            } else {
                router.push(url);
            }
        }
    };

    const goBack = () => {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab?.type === 'external') {
            window.dispatchEvent(new CustomEvent('browser-back', { detail: { tabId: activeTabId } }));
        } else {
            router.back();
        }
    };

    const goForward = () => {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab?.type === 'external') {
            window.dispatchEvent(new CustomEvent('browser-forward', { detail: { tabId: activeTabId } }));
        } else {
            router.forward();
        }
    };

    const refresh = () => {
        const activeTab = tabs.find(t => t.id === activeTabId);
        if (activeTab?.type === 'external') {
            window.dispatchEvent(new CustomEvent('browser-refresh', { detail: { tabId: activeTabId } }));
        } else {
            window.location.reload();
        }
    };

    const updateTab = (id: string, updates: Partial<Tab>) => {
        setTabs(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
    };

    return (
        <BrowserContext.Provider value={{ tabs, activeTabId, createTab, closeTab, setActiveTab, navigateActiveTab, updateTab, goBack, goForward, refresh }}>
            {children}
        </BrowserContext.Provider>
    );
};

export const useBrowser = () => {
    const context = useContext(BrowserContext);
    if (!context) throw new Error('useBrowser must be used within a BrowserProvider');
    return context;
};
