"use client";

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import SearchInput from '@/components/SearchInput';
import Avatar from '@/components/Avatar';
import api, { getIPFSUrl } from '@/lib/api';
import { FaUser, FaFile, FaFileImage, FaFileVideo, FaFileAudio, FaSpinner, FaUsers, FaLayerGroup, FaArrowLeft, FaArrowRight } from 'react-icons/fa6';
import Link from 'next/link';

interface SearchResult {
    type: 'post' | 'user';
    cid: string;
    name: string;
    description: string;
    author: string;
    avatar?: string;
    filename?: string;
    timestamp?: string;
    peer_id?: string;
}

const SearchContent = () => {
    const searchParams = useSearchParams();
    const router = useRouter();
    const initialQuery = searchParams.get('q') || '';

    const [query, setQuery] = useState(initialQuery);
    const [activeTab, setActiveTab] = useState<'all' | 'posts' | 'people'>('all');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [loading, setLoading] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);

    useEffect(() => {
        if (initialQuery) {
            handleSearch(initialQuery);
        }
    }, [initialQuery]);

    const handleSearch = async (searchQuery: string) => {
        if (searchQuery !== query) {
            setQuery(searchQuery);
            router.replace(`/search?q=${encodeURIComponent(searchQuery)}`);
        }

        if (!searchQuery.trim()) {
            setResults([]);
            setHasSearched(false);
            return;
        }

        setLoading(true);
        setHasSearched(true);
        try {
            const response = await api.post('/search', { query: searchQuery });
            setResults(response.data.results || []);
        } catch (error) {
            console.error("Search failed", error);
        } finally {
            setLoading(false);
        }
    };

    const filterResults = () => {
        if (activeTab === 'all') return results;
        return results.filter(r => r.type === (activeTab === 'people' ? 'user' : 'post'));
    };

    const getFileIcon = (filename: string) => {
        if (!filename) return <FaFile />;
        const ext = filename.split('.').pop()?.toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '')) return <FaFileImage />;
        if (['mp4', 'webm', 'mov'].includes(ext || '')) return <FaFileVideo />;
        if (['mp3', 'wav', 'ogg'].includes(ext || '')) return <FaFileAudio />;
        return <FaFile />;
    };

    const filtered = filterResults();

    return (
        <main className="relative min-h-screen w-full overflow-hidden noise-overlay">

            <div className="relative z-10 pt-28 pb-20 px-6 max-w-3xl mx-auto">
                {/* Header / Back */}
                <div className="flex items-center gap-6 mb-12">
                    <button
                        onClick={() => router.push('/')}
                        className="w-12 h-12 rounded-2xl liquid-glass liquid-glass-hover flex items-center justify-center text-white/40 hover:text-white"
                    >
                        <FaArrowLeft />
                    </button>
                    <div>
                        <h1 className="text-2xl font-extralight text-white tracking-widest text-glow uppercase">Discovery</h1>
                        <p className="text-[10px] tracking-[0.4em] text-white/20 uppercase font-black">Swarm Results</p>
                    </div>
                </div>

                <div className="mb-10">
                    <SearchInput
                        initialQuery={query}
                        onSearch={handleSearch}
                        placeholder="Search the cosmic swarm..."
                        className="liquid-glass rounded-[2rem] p-1 border-white/10 group-focus-within:border-white/20"
                    />
                </div>

                {/* Tabs */}
                {hasSearched && (
                    <div className="flex items-center space-x-2 mb-10 overflow-x-auto scrollbar-hide py-2">
                        {[
                            { id: 'all', label: 'All', icon: <FaLayerGroup /> },
                            { id: 'posts', label: 'Nodes', icon: <FaFile /> },
                            { id: 'people', label: 'Peers', icon: <FaUsers /> }
                        ].map((tab) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id as any)}
                                className={`flex items-center space-x-3 px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all whitespace-nowrap ${activeTab === tab.id
                                    ? 'liquid-glass bg-white/10 text-white border-white/20 shadow-lg'
                                    : 'text-white/20 hover:text-white/50 hover:bg-white/5 border border-transparent'
                                    }`}
                            >
                                <span className={activeTab === tab.id ? 'text-blue-400' : ''}>{tab.icon}</span>
                                <span>{tab.label}</span>
                            </button>
                        ))}
                    </div>
                )}

                {/* Results */}
                {loading ? (
                    <div className="flex flex-col items-center justify-center py-20 space-y-6 animate-pulse">
                        <FaSpinner className="text-5xl text-blue-500/50 animate-spin" />
                        <p className="text-white/20 font-black text-[10px] tracking-[0.4em] uppercase">Syncing with Swarm...</p>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {hasSearched && filtered.length === 0 && (
                            <div className="text-center py-20 liquid-glass rounded-[2rem]">
                                <p className="text-white/20 font-light italic">The swarm remained silent for "{query}"</p>
                            </div>
                        )}

                        {filtered.map((result, idx) => (
                            <div key={`${result.cid}-${idx}`} className="animate-in fade-in slide-in-from-bottom-6 duration-700" style={{ animationDelay: `${idx * 50}ms` }}>
                                {result.type === 'user' ? (
                                    <Link href={`/profile/${result.peer_id}`} className="block liquid-glass liquid-glass-hover rounded-3xl p-6 group">
                                        <div className="flex items-center space-x-6">
                                            <Avatar seed={result.peer_id} src={result.avatar} size="lg" className="group-hover:scale-110 transition-transform border border-white/5" />
                                            <div className="flex-1 min-w-0">
                                                <h3 className="font-bold text-white/90 text-lg tracking-tight truncate">{result.name || 'Anonymous Peer'}</h3>
                                                <p className="text-xs text-blue-400/60 font-medium">@{(result.author || 'unknown').replace(/^@/, '')}</p>
                                                <p className="text-xs text-white/30 mt-2 line-clamp-1 font-light italic">{result.description}</p>
                                            </div>
                                            <FaArrowRight className="text-white/5 group-hover:text-blue-400 transition-colors" />
                                        </div>
                                    </Link>
                                ) : (
                                    <Link href={`/feed?cid=${result.cid}`} className="block liquid-glass liquid-glass-hover rounded-3xl p-6 group">
                                        <div className="flex items-start space-x-6">
                                            <div className="w-14 h-14 bg-white/5 rounded-2xl flex items-center justify-center text-white/20 group-hover:text-blue-400/80 group-hover:bg-blue-500/5 transition-all border border-white/5">
                                                {getFileIcon(result.filename || '')}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h3 className="font-bold text-white/90 text-lg tracking-tight truncate">{result.name}</h3>
                                                <p className="text-[10px] text-white/20 font-black uppercase tracking-[0.1em] mt-1 space-x-2">
                                                    <span>by {result.author}</span>
                                                    <span className="opacity-20">•</span>
                                                    <span>{new Date(result.timestamp || Date.now()).toLocaleDateString()}</span>
                                                </p>
                                                <p className="text-sm text-white/40 mt-3 line-clamp-2 font-light leading-relaxed">{result.description}</p>
                                            </div>
                                        </div>
                                    </Link>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </main>
    );
};

export default function SearchPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-[#030305]">
                <FaSpinner className="text-4xl text-blue-500 animate-spin" />
            </div>
        }>
            <SearchContent />
        </Suspense>
    );
}
