"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp, ChevronDown, Check, Plus, Key, X, Cpu } from 'lucide-react';
import { useBrowser } from '@/context/BrowserContext';
import { useApiKeys } from '@/context/ApiKeysContext';
import { SiGooglegemini, SiOpenai, SiAnthropic } from 'react-icons/si';

export default function Home() {
    const router = useRouter();
    const { createTab, navigateActiveTab, activeTabId } = useBrowser();
    const { keys, setKey } = useApiKeys();
    const [query, setQuery] = useState('');
    const [mounted, setMounted] = useState(false);
    const [selectedModel, setSelectedModel] = useState('Gemini 3.1 Pro (High)');
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
    const [newKeyProvider, setNewKeyProvider] = useState<'gemini' | 'openai' | 'anthropic'>('gemini');
    const [newKeyValue, setNewKeyValue] = useState('');

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return null;

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        const input = query.trim();
        if (!input) return;

        const isURL = (str: string) => {
            if (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(str)) return true;
            if (/^[\w-]+(\.[\w-]+)+/.test(str) && !str.includes(' ')) return true;
            return false;
        };

        const normalizeURL = (str: string) => {
            if (/^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(str)) return str;
            if (/^[\w-]+(\.[\w-]+)+/.test(str)) return `https://${str}`;
            return str;
        };

        if (isURL(input)) {
            // Direct URL navigation
            const targetUrl = normalizeURL(input);
            if (activeTabId) {
                navigateActiveTab(targetUrl);
            } else {
                createTab(targetUrl);
            }
        } else {
            // AI Prompt Interaction
            // Scope: Search bar routes non-URL text to the internal AI chat interface (`bucks://chat`)
            // passing the prompt and preferred model configuration as query parameters.
            const urlSafeModel = encodeURIComponent(selectedModel);
            const prompt = encodeURIComponent(input);
            const targetUrl = `bucks://chat?q=${prompt}&model=${urlSafeModel}`;

            if (activeTabId) {
                navigateActiveTab(targetUrl);
            } else {
                createTab(targetUrl);
            }
        }
    };

    return (
        <main className="relative min-h-screen w-full flex flex-col items-center justify-center overflow-hidden noise-overlay">

            {/* Ambient Overlays */}
            <div className="fixed inset-0 bg-gradient-to-tr from-purple-500/10 via-transparent to-blue-500/10 pointer-events-none" />

            {/* Main Content Area */}
            <div className="relative z-10 w-full max-w-xl px-6 flex flex-col items-center animate-fade-in -translate-y-12">
                {/* Branding (Agentic) */}
                <div className="mb-10 flex flex-col items-center justify-center">
                    <div className="flex items-center justify-center mb-3">
                        <svg className="h-14 w-auto drop-shadow-[0_0_15px_rgba(255,255,255,0.15)]" viewBox="0 0 200 60" xmlns="http://www.w3.org/2000/svg">
                            <defs>
                                <linearGradient id="text-glow" x1="0%" y1="0%" x2="100%" y2="0%">
                                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
                                    <stop offset="50%" stopColor="#ffffff" stopOpacity="1" />
                                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0.8" />
                                </linearGradient>
                            </defs>
                            <text
                                x="50%"
                                y="54%"
                                dominantBaseline="middle"
                                textAnchor="middle"
                                fill="url(#text-glow)"
                                className="font-bold tracking-[-0.04em] text-[46px] lowercase"
                                style={{
                                    fontFamily: 'system-ui, -apple-system, sans-serif',
                                    stroke: 'rgba(255,255,255,0.4)',
                                    strokeWidth: '1px',
                                    strokeDasharray: '400',
                                    strokeDashoffset: '400',
                                    animation: 'dash 3s ease-out forwards, fillIn 2s ease-out 1s forwards'
                                }}
                            >
                                bucks
                            </text>
                            <style>
                                {`
                                    @keyframes dash {
                                        to { stroke-dashoffset: 0; }
                                    }
                                    @keyframes fillIn {
                                        0% { fill: transparent; }
                                        100% { fill: url(#text-glow); }
                                    }
                                `}
                            </style>
                        </svg>
                    </div>
                    <p className="text-[10px] tracking-[0.3em] text-white/40 font-extralight lowercase">
                        soul of the world
                    </p>
                </div>

                {/* AI Chat Input */}
                <form
                    onSubmit={handleSearch}
                    className="w-full max-w-2xl group relative"
                >
                    <div className="absolute -inset-4 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-blue-500/10 blur-3xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-1000" />

                    <div className="liquid-glass liquid-glass-hover flex items-center p-1.5 rounded-[1.5rem] group-focus-within:border-white/30 group-focus-within:shadow-[0_0_40px_rgba(255,255,255,0.05)] transition-all duration-500">
                        {/* Model Selector Dropdown */}
                        <div className="relative z-20">
                            <button
                                type="button"
                                onClick={(e) => { e.preventDefault(); setIsModelDropdownOpen(!isModelDropdownOpen); }}
                                className="flex items-center space-x-1.5 pl-4 pr-3 py-2 rounded-full hover:bg-white/10 text-white/50 hover:text-white/80 transition-colors min-w-[140px]"
                            >
                                <span className="text-xs font-medium whitespace-nowrap truncate max-w-[180px]">
                                    {(() => {
                                        const availableModels = [
                                            { id: 'gemini-high', name: 'Gemini 3.1 Pro (High)', provider: 'gemini' },
                                            { id: 'gemini-flash', name: 'Gemini 3 Flash', provider: 'gemini' },
                                            { id: 'claude-sonnet', name: 'Claude Sonnet 4.6 (Thinking)', provider: 'anthropic' },
                                            { id: 'gpt-oss', name: 'GPT-OSS 120B (Medium)', provider: 'openai' },
                                        ].filter(m => !!keys[m.provider as keyof typeof keys] && keys[m.provider as keyof typeof keys].trim() !== '');

                                        if (availableModels.length === 0) return "Add API Key";
                                        if (availableModels.some(m => m.name === selectedModel)) return selectedModel;
                                        return availableModels[0].name;
                                    })()}
                                </span>
                                <ChevronDown size={14} />
                            </button>

                            {isModelDropdownOpen && (
                                <>
                                    <div className="fixed inset-0 z-[-1]" onClick={() => setIsModelDropdownOpen(false)} />
                                    <div className="absolute top-full left-0 mt-2 w-72 bg-[#111115]/95 backdrop-blur-3xl rounded-2xl p-2 shadow-2xl border border-white/10 animate-in fade-in zoom-in-95 duration-200 text-left">
                                        <div className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white/40">Model</div>
                                        {[
                                            { id: 'gemini-high', name: 'Gemini 3.1 Pro (High)', icon: SiGooglegemini, tag: 'New', color: 'text-blue-400', provider: 'gemini' },
                                            { id: 'gemini-flash', name: 'Gemini 3 Flash', icon: SiGooglegemini, color: 'text-blue-400', provider: 'gemini' },
                                            { id: 'claude-sonnet', name: 'Claude Sonnet 4.6 (Thinking)', icon: SiAnthropic, color: 'text-orange-400', provider: 'anthropic' },
                                            { id: 'gpt-oss', name: 'GPT-OSS 120B (Medium)', icon: Cpu, color: 'text-emerald-400', provider: 'openai' },
                                        ]
                                            .filter(m => !!keys[m.provider as keyof typeof keys] && keys[m.provider as keyof typeof keys].trim() !== '')
                                            .map(model => (
                                                <button
                                                    key={model.id}
                                                    type="button"
                                                    onClick={() => { setSelectedModel(model.name); setIsModelDropdownOpen(false); }}
                                                    className={`w-full text-left px-3 py-2.5 rounded-xl flex items-center justify-between transition-colors ${selectedModel === model.name ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white'}`}
                                                >
                                                    <div className="flex items-center space-x-3">
                                                        <model.icon size={14} className={model.color} />
                                                        <span className="text-xs font-medium">{model.name}</span>
                                                    </div>
                                                    {model.tag && (
                                                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">{model.tag}</span>
                                                    )}
                                                </button>
                                            ))}

                                        <div className="h-px bg-white/10 my-2 mx-2" />

                                        <button
                                            type="button"
                                            onClick={() => { setIsModelDropdownOpen(false); setIsApiKeyModalOpen(true); }}
                                            className="w-full text-left px-3 py-2.5 rounded-xl flex items-center space-x-3 transition-colors text-white/50 hover:bg-white/5 hover:text-white"
                                        >
                                            <Plus size={14} />
                                            <span className="text-xs font-bold uppercase tracking-wider">Add API Key</span>
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* API Key Modal Inline */}
                        {isApiKeyModalOpen && (
                            <>
                                <div className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm" onClick={() => setIsApiKeyModalOpen(false)} />
                                <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[400px] bg-[#0a0a0c] rounded-3xl p-6 shadow-2xl border border-white/10 z-[130] animate-in fade-in zoom-in-95 duration-300">
                                    <div className="flex justify-between items-center mb-6">
                                        <div className="flex items-center space-x-3">
                                            <div className="w-10 h-10 rounded-2xl bg-white/5 flex items-center justify-center border border-white/10">
                                                <Key size={18} className="text-white/80" />
                                            </div>
                                            <h3 className="text-lg font-light text-white">API Keys</h3>
                                        </div>
                                        <button onClick={() => setIsApiKeyModalOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 text-white/50 hover:text-white transition-colors">
                                            <X size={16} />
                                        </button>
                                    </div>

                                    <div className="space-y-4">
                                        <div className="flex gap-2 p-1 bg-white/5 rounded-2xl border border-white/10">
                                            {[
                                                { id: 'gemini', icon: SiGooglegemini, label: 'Gemini' },
                                                { id: 'anthropic', icon: SiAnthropic, label: 'Claude' },
                                                { id: 'openai', icon: SiOpenai, label: 'ChatGPT' }
                                            ]
                                                .filter(provider => provider.id === 'gemini' || !!keys[provider.id as keyof typeof keys])
                                                .map(provider => (
                                                    <button
                                                        key={provider.id}
                                                        onClick={() => setNewKeyProvider(provider.id as any)}
                                                        className={`flex-1 py-2 flex items-center justify-center space-x-2 rounded-xl text-xs font-medium transition-colors ${newKeyProvider === provider.id ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/80'}`}
                                                    >
                                                        <provider.icon size={12} />
                                                        <span>{provider.label}</span>
                                                    </button>
                                                ))}
                                        </div>

                                        <div className="space-y-2">
                                            <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest text-white/40">
                                                <span>{newKeyProvider} Key</span>
                                                {keys[newKeyProvider] && <span className="text-emerald-400 flex items-center"><Check size={10} className="mr-1" /> Configured</span>}
                                            </div>
                                            <input
                                                type="password"
                                                value={newKeyValue}
                                                onChange={(e) => setNewKeyValue(e.target.value)}
                                                placeholder={`Paste ${newKeyProvider} API Key here...`}
                                                className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 text-sm text-white/90 placeholder-white/20 outline-none focus:bg-white/10 focus:border-white/30 focus:ring-1 focus:ring-blue-500/20 transition-all"
                                            />
                                        </div>

                                        <button
                                            onClick={() => {
                                                if (newKeyValue.trim()) {
                                                    setKey(newKeyProvider, newKeyValue.trim());
                                                    setNewKeyValue('');
                                                }
                                            }}
                                            className="w-full bg-white/10 hover:bg-white/20 text-white/80 hover:text-white py-3 rounded-xl text-xs font-black tracking-widest uppercase transition-all"
                                        >
                                            Save Key
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}

                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Ask Bucks anything..."
                            className="flex-1 bg-transparent text-white/90 placeholder-white/30 outline-none text-sm py-2 px-3 tracking-wide focus:placeholder-white/10 transition-colors"
                        />

                        <div className="pr-1.5">
                            <button
                                type="submit"
                                className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-all shadow-lg active:scale-95"
                            >
                                <ArrowUp size={16} strokeWidth={2.5} />
                            </button>
                        </div>
                    </div>
                </form>
            </div>

            {/* Bottom Glow */}
            <div className="fixed bottom-0 left-0 right-0 h-[20vh] bg-gradient-to-t from-blue-500/5 to-transparent pointer-events-none blur-3xl" />
        </main>
    );
}
