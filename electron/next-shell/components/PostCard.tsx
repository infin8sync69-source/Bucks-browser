"use client";

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { FaUser, FaEllipsis, FaTrash, FaPen, FaXmark, FaCheck, FaShare, FaHeart, FaFilePdf, FaFileZipper, FaFileLines, FaFileCode } from 'react-icons/fa6';
import { LibraryItem, getIPFSUrl, fetchInteractions, Interaction, deletePost, updatePost } from '../lib/api';
import EngagementBar from './EngagementBar';
import Comments from './Comments';
import { useToast } from './Toast';
import Avatar from './Avatar';
import FormattedDate from './FormattedDate';

interface PostCardProps {
    item: LibraryItem;
    interactions?: Interaction;
    onPostDeleted?: (cid: string) => void;
    onPostUpdated?: (cid: string, newTitle: string, newDescription: string) => void;
}

const PostCard = ({ item, interactions: initialInteractions, onPostDeleted, onPostUpdated }: PostCardProps) => {
    const post = item;
    const { showToast } = useToast();
    const [showComments, setShowComments] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState(item.name);
    const [editDescription, setEditDescription] = useState(item.description);
    const [isDeleting, setIsDeleting] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const [interactions, setInteractions] = useState(initialInteractions || {
        recommended: false,
        not_recommended: false,
        comments: [] as string[],
        views: 0,
        likes_count: 0,
        dislikes_count: 0
    });

    const isRecommended = interactions.recommended;

    const loadInteractions = async () => {
        try {
            const data = await fetchInteractions(item.cid);
            setInteractions(data);
        } catch (error) {
            console.error('Failed to load interactions', error);
        }
    };

    useEffect(() => {
        loadInteractions();
    }, [item.cid]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setShowMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleDelete = async () => {
        if (!confirm('Are you sure you want to delete this post?')) return;
        setIsDeleting(true);
        try {
            await deletePost(item.cid);
            onPostDeleted?.(item.cid);
            showToast('Post deleted', 'success');
        } catch (error) {
            showToast('Failed to delete post.', 'error');
        } finally {
            setIsDeleting(false);
            setShowMenu(false);
        }
    };

    const handleSaveEdit = async () => {
        try {
            await updatePost(item.cid, editTitle, editDescription);
            onPostUpdated?.(item.cid, editTitle, editDescription);
            setIsEditing(false);
            showToast('Post updated', 'success');
        } catch (error) {
            showToast('Failed to update post.', 'error');
        }
    };

    const [authorName, setAuthorName] = useState(item.author);
    const [authorAvatar, setAuthorAvatar] = useState(item.avatar);

    useEffect(() => {
        const syncName = () => {
            if (typeof window !== 'undefined') {
                const myPeerId = localStorage.getItem('bucks_peer_id');
                if (myPeerId && item.peer_id === myPeerId) {
                    const savedProfile = localStorage.getItem('bucks_user_profile');
                    if (savedProfile) {
                        try {
                            const profile = JSON.parse(savedProfile);
                            if (profile.username && profile.username !== authorName) setAuthorName(profile.username);
                            if (profile.avatar && profile.avatar !== authorAvatar) setAuthorAvatar(profile.avatar);
                        } catch (e) { /* ignore */ }
                    }
                }
            }
        };
        syncName();
    }, [item.peer_id]);

    const filename = item.filename || '';
    const isImage = filename.match(/\.(jpg|jpeg|png|gif|webp)$/i);
    const isVideo = filename.match(/\.(mp4|webm|mov)$/i);
    const ipfsUrl = getIPFSUrl(item.cid);

    if (isDeleting) {
        return (
            <div className="liquid-glass rounded-3xl p-12 text-center animate-pulse mb-6">
                <p className="text-white/20 font-black text-[10px] tracking-[0.4em] uppercase">Unlinking from Swarm...</p>
            </div>
        );
    }

    return (
        <div className="liquid-glass rounded-[2rem] border-white/10 mb-8 overflow-hidden animate-in fade-in slide-in-from-bottom-6 duration-1000">
            {/* Social Discovery Header */}
            {item.recommended_by && item.recommended_by.length > 0 && (
                <div className="px-6 py-3 bg-white/[0.03] flex items-center space-x-3 border-b border-white/5">
                    <div className="flex -space-x-2">
                        {item.recommended_by.slice(0, 3).map((name, i) => (
                            <div key={i} className="w-6 h-6 rounded-full bg-blue-500/10 border-2 border-[#030305] flex items-center justify-center text-[10px] font-black text-blue-400">
                                {name[0].toUpperCase()}
                            </div>
                        ))}
                    </div>
                    <span className="text-[10px] text-white/20 font-black uppercase tracking-widest">
                        Validated by <span className="text-white/60">{item.recommended_by[0]}</span>
                        {item.recommended_by.length > 1 && ` +${item.recommended_by.length - 1}`}
                    </span>
                </div>
            )}

            <div className="flex items-center justify-between px-6 py-4">
                <div className="flex items-center space-x-4">
                    <Link href={`/profile/${post.peer_id || post.author}`} className="relative group">
                        <Avatar src={authorAvatar} seed={post.peer_id || post.author} size="sm" className="border border-white/10 group-hover:scale-110 transition-transform" />
                    </Link>
                    <div className="flex flex-col">
                        <div className="flex items-center space-x-2">
                            <Link href={`/profile/${post.peer_id || post.author}`} className="font-bold text-sm text-white/90 hover:text-blue-400 transition-colors">
                                {authorName || 'Peer'}
                            </Link>
                            <span className="text-white/10 text-[10px]">•</span>
                            <FormattedDate date={post.timestamp} relative className="text-white/30 text-[10px] font-medium tracking-wide uppercase" />
                        </div>
                    </div>
                </div>

                <div className="relative" ref={menuRef}>
                    <button
                        onClick={() => setShowMenu(!showMenu)}
                        className="p-2 text-white/20 hover:text-white/60 hover:bg-white/5 rounded-xl transition-all"
                    >
                        <FaEllipsis />
                    </button>
                    {showMenu && (
                        <div className="absolute right-0 top-12 liquid-glass bg-black p-2 border-white/10 rounded-2xl shadow-2xl min-w-[200px] z-50 animate-in fade-in zoom-in-95 duration-200">
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(`${window.location.origin}/feed?cid=${post.cid}`);
                                    showToast('Link copied', 'success');
                                    setShowMenu(false);
                                }}
                                className="flex items-center space-x-3 w-full px-4 py-3 text-xs font-black uppercase tracking-widest text-white/40 hover:text-white hover:bg-white/5 rounded-xl transition-all"
                            >
                                <FaShare className="text-sm" />
                                <span>Copy CID Link</span>
                            </button>
                            <button
                                onClick={handleDelete}
                                className="flex items-center space-x-3 w-full px-4 py-3 text-xs font-black uppercase tracking-widest text-red-400/60 hover:text-red-400 hover:bg-red-500/5 rounded-xl transition-all"
                            >
                                <FaTrash className="text-sm" />
                                <span>Purge Post</span>
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Content Section */}
            <div className="px-6 mb-4">
                {isEditing ? (
                    <div className="space-y-4 liquid-glass p-4 rounded-2xl border-white/10">
                        <input
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            className="w-full bg-white/5 border border-white/5 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-blue-500/30"
                            placeholder="Title"
                        />
                        <textarea
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            className="w-full bg-white/5 border border-white/5 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-blue-500/30 resize-none"
                            placeholder="Description"
                            rows={3}
                        />
                        <div className="flex space-x-3 mt-2">
                            <button onClick={handleSaveEdit} className="flex-1 bg-blue-500/20 text-blue-400 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest border border-blue-500/20">Save</button>
                            <button onClick={() => setIsEditing(false)} className="flex-1 bg-white/5 text-white/30 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest">Cancel</button>
                        </div>
                    </div>
                ) : (
                    <>
                        <h4 className="font-bold text-white/90 text-lg tracking-tight mb-2">{post.name}</h4>
                        {post.description && (
                            <p className="text-white/50 text-sm font-light leading-relaxed mb-4">{post.description}</p>
                        )}
                    </>
                )}
            </div>

            {/* Media Area */}
            <div className="w-full bg-black/40 min-h-[300px] flex items-center justify-center relative group">
                {isImage ? (
                    <img src={ipfsUrl} alt={post.name} className="w-full h-auto max-h-[600px] object-contain group-hover:scale-[1.01] transition-transform duration-700" loading="lazy" />
                ) : isVideo ? (
                    <video src={ipfsUrl} controls className="w-full h-auto max-h-[600px]" />
                ) : (
                    <div className="p-16 text-center w-full flex flex-col items-center">
                        <div className="w-24 h-24 rounded-3xl bg-white/[0.03] border border-white/10 flex items-center justify-center mb-6 shadow-2xl transition-all group-hover:scale-110 group-hover:border-blue-500/20">
                            {(post.filename || '').match(/\.pdf$/i) ? <FaFilePdf className="text-red-500 text-4xl" /> : <FaFileLines className="text-blue-400 text-4xl" />}
                        </div>
                        <p className="text-white/20 text-[10px] font-black uppercase tracking-[0.4em] mb-8">{post.filename || 'P2P Blob'}</p>
                        <a href={ipfsUrl} className="bg-white/5 hover:bg-white/10 text-white/60 px-8 py-4 rounded-2xl border border-white/10 text-[10px] font-black uppercase tracking-widest transition-all">Download Fragment</a>
                    </div>
                )}
            </div>

            <EngagementBar
                cid={post.cid}
                initialRecommended={interactions.recommended}
                initialNotRecommended={interactions.not_recommended}
                commentsCount={interactions.comments.length}
                onCommentClick={() => setShowComments(!showComments)}
                likes_count={interactions.likes_count}
                dislikes_count={interactions.dislikes_count}
                onInteractionUpdate={(newInteractions: any) => {
                    setInteractions(prev => ({ ...prev, ...newInteractions }));
                }}
            />

            {showComments && (
                <div className="px-6 pb-6 animate-in fade-in slide-in-from-top-4 duration-500">
                    <Comments cid={item.cid} comments={interactions.comments} onCommentAdded={loadInteractions} />
                </div>
            )}
        </div>
    );
};

export default PostCard;
