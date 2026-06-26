"use client";

import React, { useRef, useEffect } from 'react';
import { useBrowser, Tab } from '@/context/BrowserContext';

const WebView = ({ tab }: { tab: Tab }) => {
    const webviewRef = useRef<any>(null);
    const { updateTab, createTab } = useBrowser();

    useEffect(() => {
        const wv = webviewRef.current;
        if (!wv) return;

        const handleNavigate = (e: any) => {
            updateTab(tab.id, { url: e.url });
        };

        const handleTitle = (e: any) => {
            updateTab(tab.id, { title: e.title });
        };

        const handleStartLoading = () => {
            updateTab(tab.id, { isLoading: true });
        };

        const handleStopLoading = () => {
            updateTab(tab.id, {
                url: wv.getURL(),
                title: wv.getTitle() || tab.title,
                isLoading: false
            });
        };

        const handleNewWindow = (e: any) => {
            createTab(e.url);
        };

        const handleFailLoad = () => {
            // Optional: Show error page or toast
        };

        wv.addEventListener('did-start-loading', handleStartLoading);
        wv.addEventListener('did-navigate', handleNavigate);
        wv.addEventListener('did-navigate-in-page', handleNavigate);
        wv.addEventListener('page-title-updated', handleTitle);
        wv.addEventListener('did-stop-loading', handleStopLoading);
        wv.addEventListener('new-window', handleNewWindow);
        wv.addEventListener('did-fail-load', handleFailLoad);

        const handleBack = (e: any) => {
            if (e.detail.tabId === tab.id && wv.canGoBack()) wv.goBack();
        };
        const handleForward = (e: any) => {
            if (e.detail.tabId === tab.id && wv.canGoForward()) wv.goForward();
        };
        const handleRefresh = (e: any) => {
            if (e.detail.tabId === tab.id) wv.reload();
        };

        window.addEventListener('browser-back', handleBack);
        window.addEventListener('browser-forward', handleForward);
        window.addEventListener('browser-refresh', handleRefresh);

        return () => {
            wv.removeEventListener('did-start-loading', handleStartLoading);
            wv.removeEventListener('did-navigate', handleNavigate);
            wv.removeEventListener('did-navigate-in-page', handleNavigate);
            wv.removeEventListener('page-title-updated', handleTitle);
            wv.removeEventListener('did-stop-loading', handleStopLoading);
            wv.removeEventListener('new-window', handleNewWindow);
            wv.removeEventListener('did-fail-load', handleFailLoad);
            window.removeEventListener('browser-back', handleBack);
            window.removeEventListener('browser-forward', handleForward);
            window.removeEventListener('browser-refresh', handleRefresh);
        };
    }, [tab.id, createTab, updateTab]);

    return (
        <webview
            ref={webviewRef}
            src={tab.url}
            className={`w-full h-full absolute inset-0 transition-opacity duration-300 ${tab.active ? 'opacity-100 pointer-events-auto z-10' : 'opacity-0 pointer-events-none z-0'}`}
            allowpopups={"true" as any}
            style={{
                border: 'none',
                background: 'white',
                height: '100%',
                width: '100%',
                contentVisibility: tab.active ? 'visible' : 'hidden'
            } as React.CSSProperties}
        />
    );
};

export default function BrowserView() {
    const { tabs, activeTabId } = useBrowser();
    const activeTab = tabs.find(t => t.id === activeTabId);

    // Only render BrowserView if we have external tabs
    const hasExternalTabs = tabs.some(t => t.type === 'external');

    if (!hasExternalTabs) return null;

    return (
        <div className={`fixed inset-0 top-16 z-[100] bg-white transition-opacity duration-500 ${activeTab?.type === 'external' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
            {tabs.filter(t => t.type === 'external').map(tab => (
                <WebView key={tab.id} tab={tab} />
            ))}
        </div>
    );
}
