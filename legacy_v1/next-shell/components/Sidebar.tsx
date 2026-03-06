"use client";

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
    Home,
    Globe,
    Layers,
    Heart,
    User,
    Settings,
    LogOut,
    Menu,
    X,
    MessageSquare
} from 'lucide-react';
import { logout } from '@/lib/api';

const Sidebar = () => {
    const pathname = usePathname();
    const isHome = pathname === '/';
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [isAuthed, setIsAuthed] = useState(false);

    useEffect(() => {
        const checkAuth = () => {
            setIsAuthed(localStorage.getItem('isAuthenticated') === 'true');
        };
        checkAuth();
        window.addEventListener('storage', checkAuth);
        return () => window.removeEventListener('storage', checkAuth);
    }, []);

    const navItems = [
        { label: 'Home', icon: Home, href: '/' },
        { label: 'Messages', icon: MessageSquare, href: '/messages' },
        { label: 'Feed', icon: Globe, href: '/feed' },
        { label: 'Services', icon: Layers, href: '/services' },
        { label: 'Recommended', icon: Heart, href: '/recommended' },
    ];

    const SidebarContent = () => (
        <div className={`flex flex-col h-full p-6 transition-all duration-700 ${isHome ? 'bg-transparent' : 'liquid-glass border-r border-white/5'}`}>
            {/* Profile Pillar Header */}
            <div className="mb-14 flex flex-col items-center">
                <Link href={isAuthed ? "/setup" : "/login"} className="relative group cursor-pointer">
                    <div className="absolute -inset-4 bg-gradient-to-tr from-purple-500/20 to-blue-500/20 rounded-full blur-[30px] opacity-0 group-hover:opacity-100 transition duration-700" />
                    <div className={`relative w-14 h-14 rounded-full border border-white/10 ${isAuthed ? 'bg-white/5' : 'bg-blue-500/10'} flex items-center justify-center overflow-hidden transition-all duration-700 group-hover:scale-110 group-hover:border-white/20 group-hover:shadow-[0_0_30px_rgba(255,255,255,0.1)]`}>
                        {isAuthed ? (
                            <User className="text-white/40 group-hover:text-white/80 w-7 h-7 transition-colors" />
                        ) : (
                            <LogOut className="text-blue-400/60 group-hover:text-blue-400 w-7 h-7 transition-colors rotate-180" />
                        )}
                    </div>
                </Link>
                <div className="mt-5 text-center">
                    <p className="text-[10px] font-black tracking-[0.4em] text-white/20 uppercase group-hover:text-white/40 transition-colors">
                        {isAuthed ? 'Swarm' : 'Guest'}
                    </p>
                </div>
            </div>

            {/* Nav Links */}
            <nav className="flex-1 space-y-6">
                {navItems.map((item) => {
                    const isActive = pathname === item.href;
                    const Icon = item.icon;
                    return (
                        <Link
                            key={item.label}
                            href={item.href}
                            onClick={() => setIsDrawerOpen(false)}
                            className={`flex flex-col items-center justify-center w-full aspect-square rounded-2xl transition-all duration-500 group ${isActive
                                ? 'liquid-glass bg-white/10 text-white border-white/20 shadow-[0_10px_30px_rgba(0,0,0,0.4)]'
                                : 'text-white/30 hover:text-white/70 hover:bg-white/[0.03]'
                                }`}
                        >
                            <Icon className={`w-5 h-5 ${isActive ? 'scale-110 text-glow' : 'group-hover:scale-110'} transition-transform`} />
                            <span className="text-[9px] mt-2 font-black tracking-[0.1em] uppercase opacity-40 group-hover:opacity-100">{item.label}</span>
                        </Link>
                    );
                })}
            </nav>

            {/* Footer Actions */}
            <div className="mt-auto space-y-4 flex flex-col items-center pt-8 border-t border-white/5">
                <Link
                    href="/settings"
                    onClick={() => setIsDrawerOpen(false)}
                    className="p-4 text-white/20 hover:text-white/60 hover:bg-white/5 rounded-2xl transition-all"
                    title="Settings"
                >
                    <Settings className="w-5 h-5" />
                </Link>
                {isAuthed ? (
                    <button
                        onClick={() => { setIsDrawerOpen(false); logout(); }}
                        className="p-4 text-red-500/20 hover:text-red-500/60 hover:bg-red-500/5 rounded-2xl transition-all"
                        title="Logout"
                    >
                        <LogOut className="w-5 h-5" />
                    </button>
                ) : (
                    <Link
                        href="/login"
                        className="p-4 text-blue-500/20 hover:text-blue-500/60 hover:bg-blue-500/5 rounded-2xl transition-all"
                        title="Login"
                    >
                        <User className="w-5 h-5" />
                    </Link>
                )}
            </div>
        </div>
    );

    return (
        <>
            {/* Desktop: Floating Glass Pillar */}
            <div className={`hidden md:flex flex-col fixed left-6 top-1/2 -translate-y-1/2 w-24 h-auto max-h-[90vh] py-10 liquid-glass rounded-[2.5rem] z-50 transition-all duration-1000 ${isHome ? 'opacity-90 hover:opacity-100 hover:border-white/20' : 'opacity-100'}`}>
                {/* Specific Sidebar contents for the pillar */}
                <div className="flex flex-col h-full items-center">
                    <SidebarContent />
                </div>
            </div>

            {/* Mobile Hamburger stays for now but adapted */}
            <div className="md:hidden">
                <button
                    onClick={() => setIsDrawerOpen(true)}
                    className="fixed top-6 left-6 z-[100] p-3 rounded-2xl bg-white/5 backdrop-blur-xl border border-white/10 text-white/70 hover:text-white shadow-2xl"
                >
                    <Menu className="w-6 h-6" />
                </button>

                {isDrawerOpen && (
                    <div className="fixed inset-0 z-[110]">
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm shadow-inner" onClick={() => setIsDrawerOpen(false)} />
                        <div className="absolute inset-y-0 left-0 w-24 bg-[#05050a] border-r border-white/5 shadow-2xl animate-in slide-in-from-left duration-500">
                            <SidebarContent />
                        </div>
                    </div>
                )}
            </div>
        </>
    );
};

export default Sidebar;
