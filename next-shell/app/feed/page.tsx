"use client";

import React, { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { usePathname } from 'next/navigation';
import StoryCircles from '@/components/StoryCircles';
import PostCard from '@/components/PostCard';
import { LibraryItem, fetchAllInteractions, fetchAggregatedFeed, fetchFollowing } from '@/lib/api';
import {
  FaFilter, FaListUl, FaImage, FaVideo, FaFileLines,
  FaCheck, FaChevronDown, FaArrowDownShortWide,
  FaPlus,
  FaEarthAmericas, FaUsers, FaArrowUpWideShort,
  FaSpinner
} from 'react-icons/fa6';
import Link from 'next/link';

export default function Feed() {
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [following, setFollowing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter states
  const [filterType, setFilterType] = useState<'all' | 'images' | 'videos' | 'files'>('all');
  const [source, setSource] = useState<'global' | 'following'>('global');
  const [sortBy, setSortBy] = useState<'newest' | 'popular'>('newest');
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [interactions, setInteractions] = useState<any>({});

  useEffect(() => {
    const loadData = async () => {
      try {
        const isAuthed = localStorage.getItem('isAuthenticated') === 'true';

        // Parallel fetch, but handleFollowing might fail if guest
        const [feedData, followingData, interactionsRes] = await Promise.all([
          fetchAggregatedFeed(),
          isAuthed ? fetchFollowing().catch(() => []) : Promise.resolve([]),
          fetchAllInteractions().catch(() => ({}))
        ]);

        setLibrary(feedData.library || []);
        setFollowing((followingData || []).map((f: any) => f.following_peer_id || f));
        setInteractions(interactionsRes || {});
      } catch (error) {
        console.error('Failed to load feed data', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  const filteredLibrary = library
    .filter(item => {
      if (filterType === 'images') {
        const isImage = item.filename.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp)$/i);
        if (!isImage) return false;
      }
      if (filterType === 'videos') {
        if (!item.filename.toLowerCase().endsWith('.mp4')) return false;
      }
      if (filterType === 'files') {
        const isMedia = item.filename.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|mp4)$/i);
        if (isMedia || item.type !== 'file') return false;
      }
      if (source === 'following') {
        if (!following.includes(item.author)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'newest') {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      }
      if (sortBy === 'popular') {
        const engagementA = (interactions[a.cid]?.recommended ? 2 : 0) + (interactions[a.cid]?.comments?.length || 0);
        const engagementB = (interactions[b.cid]?.recommended ? 2 : 0) + (interactions[b.cid]?.comments?.length || 0);
        return engagementB - engagementA;
      }
      return 0;
    });

  return (
    <main className="relative min-h-screen w-full overflow-hidden noise-overlay">

      <div className="relative z-10 pt-28 pb-32 px-6 max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex flex-col items-center mb-16 text-center">
          <h1 className="text-4xl font-extralight tracking-[0.2em] text-white/90 mb-4 text-glow">DISCOVERY</h1>
          <p className="text-[10px] tracking-[0.6em] text-white/20 uppercase font-black">Swarm Aggregation</p>
        </div>

        <div className="mb-12">
          <StoryCircles library={library} />
        </div>

        {/* Filter Controls */}
        <div className="flex items-center justify-between mb-10">
          <div className="flex items-center space-x-2">
            {[
              { id: 'all', icon: <FaListUl />, label: 'All' },
              { id: 'images', icon: <FaImage />, label: 'Media' },
              { id: 'files', icon: <FaFileLines />, label: 'Data' },
            ].map(type => (
              <button
                key={type.id}
                onClick={() => setFilterType(type.id as any)}
                className={`flex items-center space-x-2 px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all ${filterType === type.id
                  ? 'liquid-glass bg-white/10 text-white border-white/20 shadow-lg'
                  : 'text-white/20 hover:text-white/50 border border-transparent'}`}
              >
                {type.icon}
                <span className="hidden sm:inline">{type.label}</span>
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowFilterMenu(!showFilterMenu)}
            className="liquid-glass liquid-glass-hover w-12 h-12 rounded-2xl flex items-center justify-center text-white/20 hover:text-white"
          >
            <FaFilter className="text-sm" />
          </button>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 space-y-6">
            <FaSpinner className="text-5xl text-blue-500/50 animate-spin" />
            <p className="text-white/20 font-black text-[10px] tracking-[0.4em] uppercase">Connecting to Swarm...</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredLibrary.length === 0 ? (
              <div className="text-center py-20 liquid-glass rounded-[3rem] border border-dashed border-white/5">
                <p className="text-white/20 font-light italic">No signals found in the swarm.</p>
              </div>
            ) : (
              filteredLibrary.map((item) => (
                <PostCard key={item.cid} item={item} />
              ))
            )}
          </div>
        )}
      </div>

      {/* Floating Action Button */}
      <Link
        href="/create"
        className="fixed bottom-10 right-10 w-16 h-16 bg-blue-500 text-white rounded-[2rem] shadow-[0_20px_50px_rgba(59,130,246,0.3)] flex items-center justify-center text-2xl hover:scale-110 hover:shadow-[0_25px_60px_rgba(59,130,246,0.4)] transition-all z-50 group border border-white/20"
      >
        <FaPlus className="group-hover:rotate-90 transition-transform duration-500" />
      </Link>
    </main>
  );
}
