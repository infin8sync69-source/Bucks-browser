"use client";

import React from 'react';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import TopRightActions from '@/components/TopRightActions';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';
import { useBrowser } from '@/context/BrowserContext';
import { fetchProfile } from '@/lib/api';

const DynamicBrowserView = dynamic(() => import('@/components/BrowserView'), { ssr: false });
const DynamicCosmicWeb = dynamic(() => import('@/components/CosmicWeb'), { ssr: false });

// Pages where we hide navigation chrome for focused flows
const FULL_SCREEN_PAGES = ['/login', '/create', '/recover', '/qr-scan'];

export default function ClientLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const isFullScreen = FULL_SCREEN_PAGES.some(p => pathname.startsWith(p));
    const isHome = pathname === '/';
    const { createTab, activeTabId, tabs } = useBrowser();

    const activeTab = tabs.find(t => t.id === activeTabId);
    // Pause background if external tab is active
    const isPaused = activeTab?.type === 'external';

    React.useEffect(() => {
        // Fetch profile once on mount to populate localStorage cache
        if (typeof window !== 'undefined' && localStorage.getItem('bucks_peer_id')) {
            fetchProfile().catch(console.error);
        }
    }, [pathname]);

    React.useEffect(() => {
        // Listen for new-window events intercepted by Electron main process
        if (typeof window !== 'undefined' && (window as any).electron) {
            const handleNewWindow = (_e: any, { url }: { url: string }) => {
                createTab(url);
            };
            (window as any).electron.on('new-window', handleNewWindow);
            return () => {
                // Cannot easily remove listener without specific reference handle in preload,
                // but this component mounts once per app lifecycle typically.
            };
        }
    }, [createTab]);

    return (
        <div className="min-h-screen relative bg-transparent overflow-x-hidden">
            {/* Global Background Layer */}
            <DynamicCosmicWeb isPaused={isPaused} />

            {/* Universal Browser Header (Tabs + Hamburger) */}
            {!isFullScreen && <Header />}

            {/* External Webview Layer */}
            {!isFullScreen && <DynamicBrowserView />}

            {/* Main Content Area */}
            <div className={`transition-all duration-700 min-h-screen ${!isFullScreen ? 'pt-16' : ''}`}>
                <div className={`flex justify-center min-h-screen p-4 md:p-8`}>
                    <main className="w-full min-h-screen max-w-5xl">
                        <div key={pathname} className="animate-in fade-in zoom-in-95 duration-700">
                            {children}
                        </div>
                    </main>
                </div>
            </div>
        </div>
    );
}
