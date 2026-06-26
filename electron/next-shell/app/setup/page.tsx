"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { User, Sparkles, Check, ArrowRight, Shield } from 'lucide-react';

export default function ProfileSetup() {
    const [step, setStep] = useState(1);
    const [profile, setProfile] = useState({
        username: '',
        bio: '',
        handle: '',
    });
    const router = useRouter();

    const handleNext = () => setStep(s => s + 1);
    const handleFinish = () => {
        // Save profile logic here
        router.push('/');
    };

    return (
        <main className="relative min-h-screen w-full flex items-center justify-center overflow-hidden noise-overlay">

            <div className="relative z-10 w-full max-w-xl px-6">
                <div className="liquid-glass rounded-[3rem] p-16 shadow-[0_50px_120px_rgba(0,0,0,0.7)] animate-fade-in border-white/10 hover:border-white/20">

                    {/* Progress Dots */}
                    <div className="flex gap-3 mb-16 justify-center">
                        {[1, 2, 3].map(i => (
                            <div
                                key={i}
                                className={`h-1.5 rounded-full transition-all duration-700 ${step >= i ? 'w-12 bg-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.3)]' : 'w-3 bg-white/10'}`}
                            />
                        ))}
                    </div>

                    {step === 1 && (
                        <div className="animate-in fade-in slide-in-from-bottom-6 duration-1000">
                            <div className="w-20 h-20 bg-blue-500/10 border border-blue-500/20 rounded-3xl flex items-center justify-center mb-10 mx-auto group hover:scale-110 transition-transform">
                                <Shield className="text-blue-400 w-10 h-10 group-hover:text-blue-300 transition-colors" />
                            </div>
                            <h2 className="text-4xl font-extralight text-white text-center mb-6 tracking-tight text-glow">Digital Sovereignty</h2>
                            <p className="text-white/30 text-center text-sm mb-14 leading-relaxed font-light">
                                Bucks creates a unique, decentralized identity for you. <br />
                                No passwords, no centralized tracking. <br />
                                Pure mathematics protecting your presence.
                            </p>
                            <button
                                onClick={handleNext}
                                className="w-full bg-white/5 hover:bg-white/10 text-white/90 border border-white/10 py-6 rounded-3xl font-bold tracking-[0.2em] uppercase text-xs transition-all group active:scale-95 flex items-center justify-center gap-4"
                            >
                                Generate Identity
                                <ArrowRight className="w-4 h-4 group-hover:translate-x-2 transition-transform" />
                            </button>
                        </div>
                    )}

                    {step === 2 && (
                        <div className="animate-in fade-in slide-in-from-bottom-6 duration-1000">
                            <h2 className="text-4xl font-extralight text-white text-center mb-10 tracking-tight text-glow">Your Swarm Handle</h2>
                            <div className="space-y-8">
                                <div>
                                    <label className="text-[10px] uppercase tracking-[0.4em] text-white/20 font-black mb-4 block pl-1">Username</label>
                                    <input
                                        type="text"
                                        value={profile.username}
                                        onChange={e => setProfile({ ...profile, username: e.target.value })}
                                        placeholder="CosmicExplorer"
                                        className="w-full bg-white/[0.03] border border-white/10 rounded-[1.5rem] py-5 px-8 text-white outline-none focus:border-blue-500/30 transition-all placeholder:text-white/10 font-light text-lg"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase tracking-[0.4em] text-white/20 font-black mb-4 block pl-1">Short Bio</label>
                                    <textarea
                                        value={profile.bio}
                                        onChange={e => setProfile({ ...profile, bio: e.target.value })}
                                        placeholder="Exploring the decentralized frontier..."
                                        rows={3}
                                        className="w-full bg-white/[0.03] border border-white/10 rounded-[1.5rem] py-5 px-8 text-white outline-none focus:border-blue-500/30 transition-all placeholder:text-white/10 font-light text-lg resize-none"
                                    />
                                </div>
                            </div>
                            <button
                                onClick={handleNext}
                                disabled={!profile.username}
                                className="w-full mt-12 bg-white/5 hover:bg-white/10 text-white/90 border border-white/10 py-6 rounded-3xl font-bold tracking-[0.2em] uppercase text-xs transition-all group active:scale-95 flex items-center justify-center gap-4 disabled:opacity-20"
                            >
                                Finalize
                                <Sparkles className="w-4 h-4 group-hover:rotate-12 transition-transform" />
                            </button>
                        </div>
                    )}

                    {step === 3 && (
                        <div className="animate-in fade-in slide-in-from-bottom-6 duration-1000 text-center">
                            <div className="relative w-40 h-40 mx-auto mb-10">
                                <div className="absolute inset-0 bg-gradient-to-tr from-blue-500/30 to-purple-500/30 rounded-full blur-3xl animate-pulse" />
                                <div className="relative w-full h-full rounded-full border border-white/10 bg-white/5 flex items-center justify-center overflow-hidden transition-all hover:border-white/30">
                                    <User className="text-white/20 w-20 h-20" />
                                </div>
                            </div>
                            <h2 className="text-4xl font-extralight text-white mb-6 tracking-tight text-glow text-center">Identity Forged</h2>
                            <p className="text-white/30 text-sm mb-14 text-center leading-relaxed font-light">
                                Your profile is ready. <br />
                                You are now a recognized peer in the swarm.
                            </p>

                            <button
                                onClick={handleFinish}
                                className="w-full bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 py-6 rounded-3xl font-black tracking-[0.2em] uppercase text-xs transition-all flex items-center justify-center gap-4 active:scale-95 shadow-[0_10px_40px_rgba(59,130,246,0.1)]"
                            >
                                Launch Swarm
                                <Check className="w-5 h-5" />
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </main>
    );
}
