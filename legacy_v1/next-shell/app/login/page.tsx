"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FaIdCard, FaFileImport, FaCircleCheck, FaDownload, FaArrowRight, FaFingerprint, FaGlobe } from 'react-icons/fa6';
import Link from 'next/link';
import { useToast } from '@/components/Toast';

export default function LoginPage() {
    const { showToast } = useToast();
    const [step, setStep] = useState<'options' | 'generate' | 'import'>('options');
    const [newIdentity, setNewIdentity] = useState<{ did: string; secret: string } | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const router = useRouter();

    const handleGenerate = async () => {
        setIsSaving(true);
        try {
            if (typeof window !== 'undefined' && (window as any).bucksAPI) {
                const password = "password123"; // prompt() is unsupported in Next.js/Electron shell
                const response = await (window as any).bucksAPI.walletRPC({
                    method: 'POST',
                    endpoint: '/api/wallets/create',
                    body: { password }
                });

                if (response && response.result) {
                    setNewIdentity({ did: response.result.publicKey, secret: "Encrypted in Main Process" });
                    setStep('generate');
                } else {
                    throw new Error(response?.error || 'Unknown IPC Error');
                }
            } else {
                const response = await fetch(`http://${window.location.hostname}:8000/api/auth/generate-identity`, {
                    method: 'POST'
                });
                const data = await response.json();
                setNewIdentity(data);
                setStep('generate');
            }
        } catch (error) {
            console.error('Failed to generate identity', error);
            showToast('Error generating identity. Please try again.', 'error');
        } finally {
            setIsSaving(false);
        }
    };

    const handleDownload = () => {
        if (!newIdentity) return;
        const blob = new Blob([JSON.stringify(newIdentity, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ipfs_identity_${newIdentity.did.substring(0, 8)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const handleComplete = () => {
        if (newIdentity) {
            localStorage.setItem('bucks_peer_id', newIdentity.did);
            localStorage.setItem('isAuthenticated', 'true');
            router.push('/settings?onboarding=true');
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const identity = JSON.parse(event.target?.result as string);
                if (typeof window !== 'undefined' && (window as any).bucksAPI) {
                    const response = await (window as any).bucksAPI.walletRPC({
                        method: 'POST',
                        endpoint: '/api/wallets/restore',
                        body: { mnemonic: identity.secret || identity.mnemonic || JSON.stringify(identity) }
                    });

                    if (response && response.result) {
                        localStorage.setItem('bucks_peer_id', response.result.publicKey || identity.did);
                        localStorage.setItem('isAuthenticated', 'true');
                        showToast('Identity imported!', 'success');
                        router.push('/feed');
                    }
                } else {
                    if (identity.did) {
                        localStorage.setItem('bucks_peer_id', identity.did);
                        localStorage.setItem('isAuthenticated', 'true');
                        showToast('Identity imported!', 'success');
                        router.push('/feed');
                    }
                }
            } catch (err) {
                showToast('Failed to import identity.', 'error');
            }
        };
        reader.readAsText(file);
    };

    return (
        <main className="relative min-h-screen w-full flex items-center justify-center overflow-hidden noise-overlay">

            <div className="relative z-10 w-full max-w-lg px-6">
                <div className="liquid-glass rounded-[3rem] p-12 shadow-[0_50px_100px_rgba(0,0,0,0.6)] animate-fade-in border-white/10">

                    <div className="flex flex-col items-center mb-12 text-center">
                        <div className="w-16 h-16 bg-blue-500/10 border border-blue-500/20 rounded-2xl flex items-center justify-center text-blue-400 text-3xl mb-4 shadow-lg shadow-blue-500/10">
                            <FaFingerprint />
                        </div>
                        <h1 className="text-3xl font-extralight text-white tracking-widest text-glow">BUCKS SWARM</h1>
                        <p className="text-white/20 text-[10px] tracking-[0.4em] uppercase font-black mt-2">Identity Hub</p>
                    </div>

                    {step === 'options' && (
                        <div className="space-y-4">
                            <button
                                onClick={handleGenerate}
                                disabled={isSaving}
                                className="w-full liquid-glass liquid-glass-hover p-5 rounded-2xl flex items-center space-x-4 group text-left"
                            >
                                <div className="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-400 group-hover:scale-110 transition-transform">
                                    <FaIdCard className="text-xl" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="font-bold text-white/90 text-sm tracking-wide">New Identity</h3>
                                    <p className="text-[10px] text-white/20 uppercase font-black mt-0.5">Generate sovereign DID</p>
                                </div>
                                <FaArrowRight className="text-white/10 group-hover:text-blue-400 transition-all group-hover:translate-x-1" />
                            </button>

                            <button
                                onClick={() => setStep('import')}
                                className="w-full liquid-glass liquid-glass-hover p-5 rounded-2xl flex items-center space-x-4 group text-left"
                            >
                                <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-400 group-hover:scale-110 transition-transform">
                                    <FaFileImport className="text-xl" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="font-bold text-white/90 text-sm tracking-wide">Import Profile</h3>
                                    <p className="text-[10px] text-white/20 uppercase font-black mt-0.5">Upload identity.json</p>
                                </div>
                                <FaArrowRight className="text-white/10 group-hover:text-purple-400 transition-all group-hover:translate-x-1" />
                            </button>

                            <div className="pt-8 border-t border-white/5 space-y-4">
                                <button
                                    onClick={() => router.push('/')}
                                    className="w-full bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 py-5 rounded-3xl font-black tracking-[0.4em] uppercase text-[10px] transition-all flex items-center justify-center gap-4 active:scale-95 shadow-lg shadow-blue-500/5 group"
                                >
                                    <FaGlobe className="group-hover:rotate-12 transition-transform" />
                                    Enter as Guest
                                </button>

                                <div className="text-center">
                                    <Link href="/recover" className="text-[10px] font-black tracking-[0.2em] text-white/20 uppercase hover:text-white/60 transition-colors">
                                        Lost my identity? Social Recovery
                                    </Link>
                                </div>
                            </div>
                        </div>
                    )}

                    {step === 'generate' && newIdentity && (
                        <div className="space-y-6">
                            <div className="bg-green-500/10 p-4 rounded-xl border border-green-500/20 flex items-center space-x-3 text-green-400/80">
                                <FaCircleCheck className="text-xl" />
                                <p className="text-xs font-bold uppercase tracking-wider">Identity Forged</p>
                            </div>

                            <div className="space-y-4 pt-2">
                                <div className="p-5 bg-white/[0.03] rounded-2xl border border-white/5">
                                    <p className="text-[9px] font-black text-white/20 uppercase tracking-[0.3em] mb-3">Sovereign DID</p>
                                    <p className="text-[11px] font-mono text-white/60 break-all leading-relaxed">
                                        {newIdentity.did}
                                    </p>
                                </div>

                                <button
                                    onClick={handleDownload}
                                    className="w-full py-5 liquid-glass liquid-glass-hover text-white/80 rounded-2xl font-black tracking-[0.2em] uppercase text-[10px] flex items-center justify-center space-x-3 transition-all"
                                >
                                    <FaDownload />
                                    <span>Download Backup</span>
                                </button>

                                <button
                                    onClick={handleComplete}
                                    className="w-full py-5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border border-blue-500/20 rounded-2xl font-black tracking-[0.4em] uppercase text-[10px] transition-all"
                                >
                                    Enter Application
                                </button>
                            </div>
                        </div>
                    )}

                    {step === 'import' && (
                        <div className="space-y-6">
                            <div className="flex items-center justify-between mb-2">
                                <button onClick={() => setStep('options')} className="text-[10px] font-black tracking-widest text-white/20 uppercase hover:text-white/60 transition-colors">
                                    ← Back
                                </button>
                                <h2 className="font-bold text-white/90 tracking-widest uppercase text-xs">Import Identity</h2>
                            </div>

                            <label className="flex flex-col items-center justify-center w-full h-56 border-2 border-dashed border-white/5 rounded-[2rem] cursor-pointer hover:bg-white/[0.03] transition-all group relative overflow-hidden">
                                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                                    <FaFileImport className="text-4xl text-white/10 mb-5 group-hover:scale-110 group-hover:text-blue-400 transition-all" />
                                    <p className="mb-2 text-xs text-white/40 uppercase font-black tracking-widest">Select Backup File</p>
                                    <p className="text-[10px] text-white/10 uppercase font-bold">identity_*.json</p>
                                </div>
                                <input type="file" className="hidden" accept=".json" onChange={handleFileUpload} />
                            </label>
                        </div>
                    )}
                </div>
            </div>
        </main>
    );
}
