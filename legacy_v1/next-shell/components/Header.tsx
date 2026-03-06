"use client";

import React, { useState, useEffect } from 'react';
import { useBrowser } from '@/context/BrowserContext';
import { Menu, X, LogOut, User, Settings, Home, Globe, MessageSquare, Bell, ArrowLeft, ArrowRight, RotateCw, Search, LayoutGrid, Moon, Clock, Bookmark, WalletMinimal } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { logout } from '@/lib/api';

export default function Header() {
    const { tabs, activeTabId, setActiveTab, closeTab, createTab, navigateActiveTab, goBack, goForward, refresh } = useBrowser();
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [urlInput, setUrlInput] = useState('');
    const pathname = usePathname();
    const activeTab = tabs.find(t => t.id === activeTabId);
    const isHome = pathname === '/';

    // Sync URL input with active tab URL
    useEffect(() => {
        if (activeTab) {
            setUrlInput(activeTab.url === 'bucks://newtab' ? '' : activeTab.url);
        }
    }, [activeTabId, activeTab?.url]);

    const handleUrlSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const input = urlInput.trim();
        if (!input) return;

        const isURL = (str: string) => {
            if (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(str)) return true;
            if (/^[\w-]+(\.[\w-]+)+/.test(str) && !str.includes(' ')) return true;
            return false;
        };

        const normalizeURL = (str: string) => {
            if (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(str)) return str;
            if (/^[\w-]+(\.[\w-]+)+/.test(str)) return `https://${str}`;
            return `https://duckduckgo.com/?q=${encodeURIComponent(str)}`;
        };

        const targetUrl = isURL(input) ? normalizeURL(input) : `https://duckduckgo.com/?q=${encodeURIComponent(input)}`;

        if (activeTabId) {
            navigateActiveTab(targetUrl);
        } else {
            createTab(targetUrl);
        }
    };

    const menuItems = [
        { label: 'Profile', icon: User, href: '/login', color: 'text-zinc-400' },
        { label: 'Home', icon: Home, href: '/', color: 'text-blue-400' },
        { label: 'Global Feed', icon: Globe, href: '/feed', color: 'text-purple-400' },
        { label: 'Services', icon: LayoutGrid, href: '/services', color: 'text-emerald-400' },
        { label: 'Messages', icon: MessageSquare, href: '/messages', color: 'text-blue-400' },
        { label: 'Notifications', icon: Bell, href: '/notifications', color: 'text-yellow-400' },
    ];

    return (
        <header className={`fixed top-0 left-0 right-0 z-[110] h-16 flex items-center pl-20 pr-4 transition-all duration-500 ${isHome ? 'bg-transparent' : 'liquid-glass border-b border-white/5'}`}>
            {/* Left Section: Menu & Nav Controls */}
            <div className="flex items-center space-x-2">
                <button
                    onClick={() => setIsMenuOpen(!isMenuOpen)}
                    className="w-10 h-10 flex items-center justify-center rounded-xl hover:bg-white/10 transition-all active:scale-95 group relative"
                >
                    {isMenuOpen ? <X size={20} className="text-white" /> : <Menu size={20} className="text-white/70 group-hover:text-white" />}
                </button>

                <div className="flex items-center space-x-1 ml-2">
                    <button
                        onClick={goBack}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <ArrowLeft size={16} />
                    </button>
                    <button
                        onClick={goForward}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <ArrowRight size={16} />
                    </button>
                    <button
                        onClick={refresh}
                        className="w-8 h-8 flex items-center justify-center rounded-lg text-white/30 hover:text-white hover:bg-white/10 transition-all"
                    >
                        <RotateCw size={14} className={activeTab?.isLoading ? "animate-spin text-white/70" : ""} />
                    </button>
                </div>
            </div>

            {/* Middle Section: Omnibox / URL Bar */}
            <div className="flex-1 mx-6 max-w-2xl">
                <form onSubmit={handleUrlSubmit} className="relative group">
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-white/20 group-focus-within:text-blue-400/50 transition-colors">
                        <Search size={14} />
                    </div>
                    <input
                        type="text"
                        value={urlInput}
                        onChange={(e) => setUrlInput(e.target.value)}
                        placeholder="Search or enter address"
                        className="w-full bg-white/5 border border-white/10 rounded-2xl py-2 pl-11 pr-4 text-sm text-white/80 placeholder-white/20 outline-none focus:bg-white/10 focus:border-white/20 focus:ring-1 focus:ring-blue-500/20 transition-all"
                    />
                </form>
            </div>

            {/* Right Section: Tabs & Profile/Settings */}
            <div className="flex items-center justify-end">
                <div className="flex items-center space-x-2 overflow-x-auto no-scrollbar max-w-md pl-4">
                    {tabs.map(tab => (
                        <div
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`group px-4 py-1.5 rounded-xl border transition-all flex items-center justify-between space-x-2 cursor-pointer select-none whitespace-nowrap min-w-[100px] max-w-[160px] flex-shrink-0 ${tab.id === activeTabId
                                ? 'bg-white/10 border-white/20 text-white shadow-lg'
                                : 'border-transparent text-white/40 hover:bg-white/5 hover:text-white/80'
                                }`}
                        >
                            <span className="text-[10px] font-bold tracking-wide truncate">{tab.title}</span>
                            <button
                                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-white/10 rounded-md transition-all"
                            >
                                <X size={10} />
                            </button>
                        </div>
                    ))}

                    <button
                        onClick={() => createTab()}
                        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/20 hover:text-white transition-all border border-dashed border-white/5"
                        title="New Tab"
                    >
                        <span className="text-lg font-light">+</span>
                    </button>
                </div>

                <div className="flex items-center space-x-1 pl-4 ml-4 border-l border-white/10 h-10">
                    <Link
                        href="/wallet"
                        className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all active:scale-95 group ${pathname === '/wallet' || pathname === '/wallet/' ? 'text-blue-400 bg-blue-500/10' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
                        title="Wallet"
                    >
                        <WalletMinimal size={20} className="group-hover:scale-110 transition-transform duration-300" />
                    </Link>
                    <div className="relative">
                        <button
                            onClick={() => setIsSettingsOpen(!isSettingsOpen)}
                            className="w-10 h-10 flex items-center justify-center rounded-xl text-white/70 hover:text-white hover:bg-white/10 transition-all active:scale-95 group"
                        >
                            {isSettingsOpen ? <X size={20} /> : <Settings size={20} className="group-hover:rotate-90 transition-transform duration-500" />}
                        </button>

                        {isSettingsOpen && (
                            <>
                                <div className="fixed inset-0 z-[-1]" onClick={() => setIsSettingsOpen(false)} />
                                <div className="absolute top-12 right-0 w-48 bg-[#0a0a0c]/95 backdrop-blur-3xl rounded-2xl p-2 shadow-2xl border border-white/10 animate-in fade-in zoom-in-95 duration-200">
                                    <div className="flex flex-col space-y-1">
                                        <button onClick={() => {
                                            const isLight = document.documentElement.classList.toggle('light-mode');
                                            localStorage.setItem('bucks_theme', isLight ? 'light' : 'dark');
                                            // Force a tiny re-render trigger just for the text (or let user reopen menu to see "Dark Mode")
                                            setIsSettingsOpen(false);
                                        }} className="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 transition-all text-left group w-full">
                                            <Moon size={14} className="text-blue-400 group-hover:scale-110 transition-transform" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-white/80">Toggle Theme</span>
                                        </button>
                                        <button className="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 transition-all text-left group w-full">
                                            <Clock size={14} className="text-purple-400 group-hover:scale-110 transition-transform" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-white/80">History</span>
                                        </button>
                                        <button className="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 transition-all text-left group w-full">
                                            <Bookmark size={14} className="text-emerald-400 group-hover:scale-110 transition-transform" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-white/80">Bookmarks</span>
                                        </button>
                                        <div className="h-px bg-white/10 my-1 mx-2" />
                                        <Link href="/settings" onClick={() => setIsSettingsOpen(false)} className="flex items-center space-x-3 p-3 rounded-xl hover:bg-white/10 transition-all text-left group w-full">
                                            <Settings size={14} className="text-white/40 group-hover:text-white group-hover:scale-110 transition-transform" />
                                            <span className="text-[10px] font-bold uppercase tracking-widest text-white/80">All Settings</span>
                                        </Link>
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Menu Dropdown */}
            {isMenuOpen && (
                <>
                    <div className="fixed inset-0 z-[-1]" onClick={() => setIsMenuOpen(false)} />
                    <div className="absolute top-20 left-20 w-72 bg-[#0a0a0c]/95 backdrop-blur-3xl rounded-3xl p-3 shadow-2xl border border-white/10 animate-in fade-in zoom-in-95 duration-300">
                        <div className="flex flex-col space-y-1">
                            {menuItems.map(item => (
                                <Link
                                    key={item.label}
                                    href={item.href}
                                    onClick={() => setIsMenuOpen(false)}
                                    className="flex items-center space-x-4 p-4 rounded-2xl hover:bg-white/10 transition-all group"
                                >
                                    <item.icon size={18} className={`${item.color} group-hover:scale-110 transition-transform`} />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-white/60 group-hover:text-white">{item.label}</span>
                                </Link>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </header>
    );
}
