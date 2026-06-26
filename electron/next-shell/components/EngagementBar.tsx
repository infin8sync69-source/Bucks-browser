"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FaArrowUp, FaArrowDown, FaRegComment, FaShare } from 'react-icons/fa6';
import { toggleLike, toggleDislike } from '../lib/api';

interface EngagementBarProps {
    cid: string;
    initialRecommended: boolean;
    initialNotRecommended: boolean;
    commentsCount: number;
    onCommentClick: () => void;
}

const EngagementBar = ({
    cid,
    initialRecommended,
    initialNotRecommended,
    commentsCount,
    onCommentClick,
    onInteractionUpdate,
    likes_count = 0,
    dislikes_count = 0
}: EngagementBarProps & { likes_count?: number; dislikes_count?: number; onInteractionUpdate?: (updates: any) => void }) => {
    const router = useRouter();
    const [recommended, setRecommended] = useState(initialRecommended);
    const [notRecommended, setNotRecommended] = useState(initialNotRecommended);
    const [likesCount, setLikesCount] = useState(likes_count);
    const [dislikesCount, setDislikesCount] = useState(dislikes_count);

    const checkAuth = () => {
        const isAuthed = localStorage.getItem('isAuthenticated') === 'true';
        if (!isAuthed) {
            console.log('[EngagementBar] Guest detected, redirecting to login');
            router.push('/login');
            return false;
        }
        return true;
    };

    const handleLike = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!checkAuth()) return;

        const newRecommended = !recommended;
        setRecommended(newRecommended);
        setLikesCount(prev => newRecommended ? prev + 1 : prev - 1);

        if (newRecommended && notRecommended) {
            setNotRecommended(false);
            setDislikesCount(prev => prev - 1);
        }

        try {
            await toggleLike(cid);
            onInteractionUpdate?.({
                recommended: newRecommended,
                not_recommended: newRecommended ? false : notRecommended,
                likes_count: newRecommended ? likesCount + 1 : likesCount - 1,
                dislikes_count: newRecommended && notRecommended ? dislikesCount - 1 : dislikesCount
            });
        } catch (error) {
            setRecommended(!newRecommended);
            setLikesCount(prev => !newRecommended ? prev + 1 : prev - 1);
        }
    };

    const handleDislike = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!checkAuth()) return;

        const newNotRecommended = !notRecommended;
        setNotRecommended(newNotRecommended);
        setDislikesCount(prev => newNotRecommended ? prev + 1 : prev - 1);

        if (newNotRecommended && recommended) {
            setRecommended(false);
            setLikesCount(prev => prev - 1);
        }

        try {
            await toggleDislike(cid);
            onInteractionUpdate?.({
                recommended: newNotRecommended ? false : recommended,
                not_recommended: newNotRecommended,
                likes_count: newNotRecommended && recommended ? likesCount - 1 : likesCount,
                dislikes_count: newNotRecommended ? dislikesCount + 1 : dislikesCount - 1
            });
        } catch (error) {
            setNotRecommended(!newNotRecommended);
            setDislikesCount(prev => !newNotRecommended ? prev + 1 : prev - 1);
        }
    };

    const handleCommentClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!checkAuth()) return;
        onCommentClick();
    };

    return (
        <div className="flex items-center justify-between py-4 px-6 mt-1 border-t border-white/5">
            <div className="flex items-center space-x-6">
                {/* Like / Vote Actions */}
                <div className="flex items-center liquid-glass bg-white/5 rounded-2xl px-2 py-1 border-white/10 group">
                    <button
                        onClick={handleLike}
                        className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all active:scale-95 ${recommended
                            ? 'text-blue-400 bg-blue-500/10'
                            : 'text-white/30 hover:text-white/60 hover:bg-white/5'
                            }`}
                    >
                        <FaArrowUp className="text-lg" />
                    </button>

                    <span className={`text-xs font-black min-w-[3ch] text-center tracking-tighter ${recommended || notRecommended ? 'text-white/80' : 'text-white/20'}`}>
                        {likesCount - dislikesCount}
                    </span>

                    <button
                        onClick={handleDislike}
                        className={`flex items-center justify-center w-10 h-10 rounded-xl transition-all active:scale-95 ${notRecommended
                            ? 'text-red-400 bg-red-500/10'
                            : 'text-white/30 hover:text-white/60 hover:bg-white/5'
                            }`}
                    >
                        <FaArrowDown className="text-lg" />
                    </button>
                </div>

                {/* Comment Action */}
                <button
                    onClick={handleCommentClick}
                    className="flex items-center space-x-2 px-4 py-2 rounded-2xl text-white/30 hover:text-white/80 hover:bg-white/[0.03] transition-all active:scale-95 group"
                >
                    <FaRegComment className="text-lg group-hover:scale-110 transition-transform" />
                    <span className="text-[10px] font-black uppercase tracking-widest">{commentsCount || ''}</span>
                </button>

                {/* Share Action */}
                <button
                    onClick={(e) => {
                        e.preventDefault();
                        const shareUrl = `${window.location.origin}/feed?cid=${cid}`;
                        navigator.clipboard.writeText(shareUrl)
                            .then(() => alert('Link copied to clipboard!'))
                            .catch(() => prompt('Copy link:', shareUrl));
                    }}
                    className="flex items-center justify-center w-10 h-10 rounded-2xl text-white/20 hover:text-white/80 hover:bg-white/[0.03] transition-all active:scale-95"
                >
                    <FaShare className="text-lg" />
                </button>
            </div>
        </div>
    );
};

export default EngagementBar;
