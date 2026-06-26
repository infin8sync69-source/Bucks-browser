"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Pickaxe, Play, Square, Zap, Cpu, Box, ArrowLeft, Hash, Activity, Download, CheckCircle, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

async function rpc(method: string, endpoint: string, body?: any) {
    if (typeof window !== 'undefined' && (window as any).bucksAPI) {
        return await (window as any).bucksAPI.walletRPC({ method, endpoint, body });
    }
    const res = await fetch(`http://localhost:8080${endpoint}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json();
}

type MiningStatus = {
    mining: boolean;
    minerAddress: string;
    blocksFound: number;
    hashRate: number;
};

type ChainInfo = {
    height: number;
    difficulty: number;
    utxoCount: number;
};

type SetupStep = 'check' | 'not-installed' | 'downloading' | 'installing' | 'ready' | 'dashboard';

export default function MiningPage() {
    const router = useRouter();
    const [setupStep, setSetupStep] = useState<SetupStep>('check');
    const [miningStatus, setMiningStatus] = useState<MiningStatus | null>(null);
    const [chainInfo, setChainInfo] = useState<ChainInfo | null>(null);
    const [isMining, setIsMining] = useState(false);
    const [isMiningBlock, setIsMiningBlock] = useState(false);
    const [lastMinedBlock, setLastMinedBlock] = useState<any>(null);
    const [toastMessage, setToastMessage] = useState('');
    const [customMinerAddress, setCustomMinerAddress] = useState('');

    // Check if mining package is "installed" by seeing if node is responsive
    useEffect(() => {
        const checkNode = async () => {
            try {
                const res = await rpc('GET', '/api/blockchain/info');
                if (res && res.height !== undefined) {
                    setSetupStep('dashboard');
                } else {
                    setSetupStep('not-installed');
                }
            } catch (e) {
                setSetupStep('not-installed');
            }
        };
        checkNode();

        const savedStr = localStorage.getItem('bucks_wallet_v2');
        if (savedStr) {
            try {
                const walletData = JSON.parse(savedStr);
                if (walletData.address) {
                    setCustomMinerAddress(walletData.address);
                }
            } catch { }
        }
    }, []);

    const fetchStatus = useCallback(async () => {
        try {
            const [mRes, cRes] = await Promise.all([
                rpc('GET', '/api/mining/status'),
                rpc('GET', '/api/blockchain/info'),
            ]);
            if (mRes) {
                setMiningStatus(mRes);
                setIsMining(mRes.mining);
            }
            if (cRes) setChainInfo(cRes);
        } catch { }
    }, []);

    useEffect(() => {
        if (setupStep !== 'dashboard') return;
        fetchStatus();
    }, [setupStep, fetchStatus]);

    // Poll when on dashboard
    useEffect(() => {
        if (setupStep !== 'dashboard') return;
        const interval = setInterval(fetchStatus, isMining ? 2000 : 8000);
        return () => clearInterval(interval);
    }, [isMining, fetchStatus, setupStep]);

    // User must run node locally
    const handleDownload = () => {
        setSetupStep('downloading');
        // Simulate a brief check before showing instructions
        setTimeout(() => {
            setSetupStep('ready');
        }, 1500);
    };

    const syncMinerAddress = async () => {
        try {
            if (!customMinerAddress) return false;
            const res = await rpc('POST', '/api/mining/address', { address: customMinerAddress });
            return res?.success;
        } catch {
            return false;
        }
    };

    const handleToggleMining = async () => {
        try {
            if (isMining) {
                await rpc('POST', '/api/mining/stop');
                setIsMining(false);
                showToast('Mining stopped');
            } else {
                await syncMinerAddress();
                const res = await rpc('POST', '/api/mining/start');
                if (res?.success) {
                    setIsMining(true);
                    showToast('Mining started!');
                }
            }
            fetchStatus();
        } catch {
            showToast('Failed to toggle mining');
        }
    };

    const handleMineBlock = async () => {
        setIsMiningBlock(true);
        try {
            await syncMinerAddress();
            const res = await rpc('POST', '/api/mining/mine');
            if (res?.success && res?.block) {
                setLastMinedBlock(res.block);
                showToast(`Block #${res.block.height} mined!`);
                fetchStatus();
            } else {
                showToast(res?.error || 'Mining failed');
            }
        } catch {
            showToast('Mining error');
        } finally {
            setIsMiningBlock(false);
        }
    };

    const showToast = (msg: string) => {
        setToastMessage(msg);
        setTimeout(() => setToastMessage(''), 3000);
    };

    return (
        <main className="relative min-h-screen w-full flex items-center justify-center overflow-hidden noise-overlay">
            <div className="fixed inset-0 bg-gradient-to-br from-amber-500/5 via-transparent to-orange-500/5 pointer-events-none" />

            {/* Mining pulse when active */}
            {isMining && setupStep === 'dashboard' && (
                <div className="fixed inset-0 pointer-events-none">
                    <div className="absolute inset-0 bg-amber-500/[0.02] animate-pulse" style={{ animationDuration: '3s' }} />
                </div>
            )}

            <AnimatePresence mode="wait">
                {/* ─── CHECKING ─── */}
                {setupStep === 'check' && (
                    <motion.div key="check" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center gap-4">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500" />
                        <p className="text-[10px] font-black tracking-[0.4em] text-white/30 uppercase">Checking Mining Setup</p>
                    </motion.div>
                )}

                {/* ─── NOT INSTALLED ─── */}
                {setupStep === 'not-installed' && (
                    <motion.div key="not-installed" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} transition={{ duration: 0.5 }} className="relative z-10 w-full max-w-lg px-6">
                        <div className="liquid-glass rounded-[3rem] p-12 shadow-[0_50px_100px_rgba(0,0,0,0.6)] border-white/10">
                            <div className="flex flex-col items-center mb-10 text-center">
                                <div className="w-20 h-20 bg-amber-500/10 border border-amber-500/20 rounded-3xl flex items-center justify-center text-amber-400 text-4xl mb-5 shadow-lg shadow-amber-500/10">
                                    <Pickaxe />
                                </div>
                                <h1 className="text-3xl font-extralight text-white tracking-widest text-glow">BUCKS MINER</h1>
                                <p className="text-white/20 text-[10px] tracking-[0.4em] uppercase font-black mt-3">Proof-of-Work Mining Engine</p>
                            </div>

                            <div className="space-y-4">
                                <div className="p-5 bg-white/[0.02] rounded-2xl border border-white/5">
                                    <div className="flex items-center gap-3 mb-3">
                                        <Cpu className="w-4 h-4 text-amber-400/60" />
                                        <span className="text-[10px] font-black tracking-[0.3em] text-white/30 uppercase">Mining Package</span>
                                    </div>
                                    <ul className="space-y-2 text-xs text-white/40">
                                        <li className="flex items-center gap-2">
                                            <div className="w-1 h-1 rounded-full bg-amber-400/40" />
                                            SHA-256 PoW mining engine
                                        </li>
                                        <li className="flex items-center gap-2">
                                            <div className="w-1 h-1 rounded-full bg-amber-400/40" />
                                            Block reward: 50 BUCKS per block
                                        </li>
                                        <li className="flex items-center gap-2">
                                            <div className="w-1 h-1 rounded-full bg-amber-400/40" />
                                            Auto-mining with live hash rate
                                        </li>
                                    </ul>
                                    <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
                                        <span className="text-[10px] text-white/20">Package Size</span>
                                        <span className="text-[10px] font-mono text-white/30">24.8 MB</span>
                                    </div>
                                </div>

                                <button
                                    onClick={handleDownload}
                                    className="w-full py-5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/20 rounded-3xl font-black tracking-[0.4em] uppercase text-[10px] transition-all flex items-center justify-center gap-4 active:scale-95 shadow-lg shadow-amber-500/5 group"
                                >
                                    <Download className="w-4 h-4 group-hover:scale-110 transition-transform" />
                                    Setup Mining Node
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* ─── DOWNLOADING INSTRUCTIONS ─── */}
                {setupStep === 'downloading' && (
                    <motion.div key="downloading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="relative z-10 w-full max-w-lg px-6">
                        <div className="liquid-glass rounded-[3rem] p-12 shadow-[0_50px_100px_rgba(0,0,0,0.6)] border-white/10">
                            <div className="flex flex-col items-center mb-8 text-center">
                                <div className="w-16 h-16 bg-amber-500/10 border border-amber-500/20 rounded-2xl flex items-center justify-center text-amber-400 mb-5">
                                    <Cpu className="w-6 h-6 animate-pulse" />
                                </div>
                                <h2 className="text-xl font-light text-white tracking-widest">Checking Local Node</h2>
                                <p className="text-white/20 text-[10px] tracking-[0.3em] uppercase mt-2">Connecting to localhost:8080</p>
                            </div>
                        </div>
                    </motion.div>
                )}

                {/* ─── READY / INSTRUCTIONS ─── */}
                {setupStep === 'ready' && (
                    <motion.div key="ready" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="relative z-10 w-full max-w-lg px-6">
                        <div className="liquid-glass rounded-[3rem] p-12 shadow-[0_50px_100px_rgba(0,0,0,0.6)] border-white/10 text-center">
                            <div className="w-20 h-20 bg-blue-500/10 border border-blue-500/20 rounded-3xl flex items-center justify-center text-blue-400 mx-auto mb-6 shadow-lg shadow-blue-500/10">
                                <Box className="w-8 h-8" />
                            </div>
                            <h2 className="text-xl font-light text-white tracking-widest mb-2">Local Node Required</h2>
                            <p className="text-white/40 text-xs mb-8">
                                To mine blocks, you must run the Bucks core node locally on your machine. The browser client will securely connect to your node to manage mining operations.
                            </p>

                            <div className="bg-black/40 border border-white/5 rounded-xl p-4 mb-8 text-left">
                                <p className="text-[10px] font-black tracking-[0.2em] text-white/30 uppercase mb-2">Terminal Command</p>
                                <code className="font-mono text-xs text-amber-400 select-all tracking-tight">./bucks_node --mine</code>
                            </div>

                            <button
                                onClick={() => {
                                    setSetupStep('check');
                                    fetchStatus();
                                }}
                                className="w-full py-5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/20 rounded-3xl font-black tracking-[0.4em] uppercase text-[10px] transition-all active:scale-95"
                            >
                                I'm running the node
                            </button>
                        </div>
                    </motion.div>
                )}

                {/* ─── DASHBOARD ─── */}
                {setupStep === 'dashboard' && (
                    <motion.div key="dashboard" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.5 }} className="relative z-10 w-full max-w-2xl px-6">
                        <div className="space-y-6">
                            {/* Header Card */}
                            <div className="liquid-glass rounded-[2.5rem] p-10 border-white/10 shadow-[0_50px_100px_rgba(0,0,0,0.6)]">
                                <div className="flex items-center justify-between mb-8">
                                    <div className="flex items-center gap-4">
                                        <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-all duration-500 ${isMining
                                            ? 'bg-amber-500/20 border border-amber-500/30 text-amber-400 shadow-amber-500/20'
                                            : 'bg-white/5 border border-white/10 text-white/40'
                                            }`}>
                                            <Pickaxe className="w-6 h-6" />
                                        </div>
                                        <div>
                                            <h1 className="text-xl font-light text-white tracking-widest">MINING</h1>
                                            <div className="flex items-center gap-2 mt-1">
                                                <div className={`w-2 h-2 rounded-full transition-all duration-500 ${isMining ? 'bg-green-400 shadow-lg shadow-green-400/50 animate-pulse' : 'bg-white/10'}`} />
                                                <p className="text-[10px] font-black tracking-[0.3em] text-white/20 uppercase">
                                                    {isMining ? 'Active' : 'Idle'}
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => router.push('/wallet')}
                                        className="p-3 text-white/20 hover:text-white/60 hover:bg-white/5 rounded-xl transition-all"
                                        title="Back to Wallet"
                                    >
                                        <ArrowLeft className="w-4 h-4" />
                                    </button>
                                </div>

                                {/* Mining Controls */}
                                <div className="flex gap-3">
                                    <button
                                        onClick={handleToggleMining}
                                        className={`flex-1 py-5 rounded-3xl font-black tracking-[0.4em] uppercase text-[10px] transition-all active:scale-95 flex items-center justify-center gap-3 shadow-lg ${isMining
                                            ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/20 shadow-red-500/5'
                                            : 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/20 shadow-amber-500/5'
                                            }`}
                                    >
                                        {isMining ? (
                                            <><Square className="w-4 h-4" /> Stop Mining</>
                                        ) : (
                                            <><Play className="w-4 h-4" /> Start Mining</>
                                        )}
                                    </button>

                                    <button
                                        onClick={handleMineBlock}
                                        disabled={isMiningBlock}
                                        className="px-8 py-5 liquid-glass liquid-glass-hover rounded-3xl font-black tracking-[0.2em] uppercase text-[10px] text-white/50 transition-all active:scale-95 flex items-center gap-3 disabled:opacity-30"
                                    >
                                        {isMiningBlock ? (
                                            <><Loader2 className="w-4 h-4 animate-spin" /> Mining...</>
                                        ) : (
                                            <><Zap className="w-4 h-4" /> Mine Block</>
                                        )}
                                    </button>
                                </div>
                            </div>

                            {/* Stats Grid */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="liquid-glass rounded-2xl p-6 border-white/10">
                                    <div className="flex items-center gap-2 mb-3">
                                        <Activity className="w-3 h-3 text-amber-400/50" />
                                        <p className="text-[9px] font-black tracking-[0.3em] text-white/20 uppercase">Hash Rate</p>
                                    </div>
                                    <p className="text-2xl font-light text-white/80">{miningStatus?.hashRate ? `${miningStatus.hashRate.toLocaleString()}` : '0'}</p>
                                    <p className="text-[9px] font-black tracking-[0.2em] text-white/15 uppercase mt-1">H/s</p>
                                </div>
                                <div className="liquid-glass rounded-2xl p-6 border-white/10">
                                    <div className="flex items-center gap-2 mb-3">
                                        <Box className="w-3 h-3 text-blue-400/50" />
                                        <p className="text-[9px] font-black tracking-[0.3em] text-white/20 uppercase">Blocks Found</p>
                                    </div>
                                    <p className="text-2xl font-light text-white/80">{miningStatus?.blocksFound ?? 0}</p>
                                    <p className="text-[9px] font-black tracking-[0.2em] text-white/15 uppercase mt-1">Total</p>
                                </div>
                                <div className="liquid-glass rounded-2xl p-6 border-white/10">
                                    <div className="flex items-center gap-2 mb-3">
                                        <Hash className="w-3 h-3 text-purple-400/50" />
                                        <p className="text-[9px] font-black tracking-[0.3em] text-white/20 uppercase">Chain Height</p>
                                    </div>
                                    <p className="text-2xl font-light text-white/80">{chainInfo?.height ?? 0}</p>
                                    <p className="text-[9px] font-black tracking-[0.2em] text-white/15 uppercase mt-1">Blocks</p>
                                </div>
                                <div className="liquid-glass rounded-2xl p-6 border-white/10">
                                    <div className="flex items-center gap-2 mb-3">
                                        <Cpu className="w-3 h-3 text-green-400/50" />
                                        <p className="text-[9px] font-black tracking-[0.3em] text-white/20 uppercase">Difficulty</p>
                                    </div>
                                    <p className="text-2xl font-light text-white/80">{chainInfo?.difficulty ?? 0}</p>
                                    <p className="text-[9px] font-black tracking-[0.2em] text-white/15 uppercase mt-1">Target</p>
                                </div>
                            </div>

                            {/* Miner Address */}
                            <div className="bg-white/[0.02] rounded-xl p-4 border border-white/5">
                                <p className="text-[9px] font-black tracking-[0.3em] text-white/20 uppercase mb-2">Miner Reward Address</p>
                                {isMining ? (
                                    <p className="text-xs font-mono text-amber-400/80 break-all">{miningStatus?.minerAddress || customMinerAddress}</p>
                                ) : (
                                    <input
                                        type="text"
                                        value={customMinerAddress}
                                        onChange={(e) => setCustomMinerAddress(e.target.value)}
                                        placeholder="Enter wallet address for rewards..."
                                        className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-3 text-xs font-mono text-white focus:outline-none focus:border-amber-500/50 transition-colors"
                                    />
                                )}
                            </div>

                            {/* Last Mined Block */}
                            <AnimatePresence>
                                {lastMinedBlock && (
                                    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="liquid-glass rounded-2xl p-6 border-green-500/10">
                                        <div className="flex items-center gap-2 mb-3">
                                            <div className="w-2 h-2 rounded-full bg-green-400" />
                                            <p className="text-[9px] font-black tracking-[0.3em] text-green-400/60 uppercase">Last Mined Block</p>
                                        </div>
                                        <div className="grid grid-cols-3 gap-4 text-center">
                                            <div>
                                                <p className="text-[9px] font-black tracking-[0.2em] text-white/20 uppercase mb-1">Height</p>
                                                <p className="text-sm text-white/70">{lastMinedBlock.height}</p>
                                            </div>
                                            <div>
                                                <p className="text-[9px] font-black tracking-[0.2em] text-white/20 uppercase mb-1">Nonce</p>
                                                <p className="text-sm text-white/70">{lastMinedBlock.nonce}</p>
                                            </div>
                                            <div>
                                                <p className="text-[9px] font-black tracking-[0.2em] text-white/20 uppercase mb-1">TXs</p>
                                                <p className="text-sm text-white/70">{lastMinedBlock.transactionCount}</p>
                                            </div>
                                        </div>
                                        <p className="text-[10px] font-mono text-white/20 mt-3 break-all">{lastMinedBlock.hash}</p>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Toast */}
            <AnimatePresence>
                {toastMessage && (
                    <motion.div
                        initial={{ opacity: 0, y: 50 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 50 }}
                        className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 px-6 py-3 bg-white/10 backdrop-blur-xl border border-white/10 rounded-2xl text-xs text-white/80 font-medium shadow-2xl"
                    >
                        {toastMessage}
                    </motion.div>
                )}
            </AnimatePresence>
        </main>
    );
}
