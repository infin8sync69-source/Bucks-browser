"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
    WalletMinimal, Copy, Check, ArrowRight, Shield, Pickaxe, RefreshCw,
    Eye, EyeOff, Send, QrCode, Key, ArrowDownLeft, ChevronDown, ChevronUp,
    LogOut, Plus, Import, AlertTriangle, ArrowLeft, Loader2, CheckCircle,
    Server
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Import our new client-side crypto library
import { createWallet, restoreWallet, buildAndSignTransaction, UTXO } from '../../lib/bucks-crypto';

/* ─── Types ─── */
type WalletInfo = {
    address: string;
    balance: number;
    publicKey: string;
    privateKey: string;
    mnemonic?: string;
};
type FlowStep =
    | 'loading' | 'welcome'
    | 'creating' | 'mnemonic-display' | 'mnemonic-verify'
    | 'import' | 'import-verifying'
    | 'dashboard';
type DashboardTab = 'overview' | 'send' | 'receive' | 'keys' | 'network';
type SendPhase = 'form' | 'review' | 'sending' | 'receipt';

/* ─── Constants ─── */
const STORAGE_KEY = 'bucks_wallet_v2';
const NODE_URL_KEY = 'bucks_node_url';
const DEFAULT_NODE_URL = 'http://localhost:8080';

export default function WalletPage() {
    const router = useRouter();

    /* ─── State ─── */
    const [step, setStep] = useState<FlowStep>('loading');
    const [wallet, setWallet] = useState<WalletInfo | null>(null);
    const [nodeUrl, setNodeUrl] = useState(DEFAULT_NODE_URL);
    const [chainInfo, setChainInfo] = useState<any>(null);
    const [dashTab, setDashTab] = useState<DashboardTab>('overview');

    // Mnemonic create
    const [mnemonic, setMnemonic] = useState('');
    const [verifyIndices, setVerifyIndices] = useState<number[]>([]);
    const [verifyAnswers, setVerifyAnswers] = useState<(string | null)[]>([null, null, null]);
    const [verifyError, setVerifyError] = useState('');

    // Import
    const [importPhrase, setImportPhrase] = useState('');
    const [importError, setImportError] = useState('');

    // Send
    const [sendTo, setSendTo] = useState('');
    const [sendAmount, setSendAmount] = useState('');
    const [sendPhase, setSendPhase] = useState<SendPhase>('form');
    const [sendResult, setSendResult] = useState<{ success: boolean; hash?: string; error?: string } | null>(null);

    // Keys
    const [showPrivateKey, setShowPrivateKey] = useState(false);
    const [showMnemonic, setShowMnemonic] = useState(false);

    // Copy
    const [copiedField, setCopiedField] = useState('');

    // Reset
    const [confirmReset, setConfirmReset] = useState(false);

    /* ─── Helpers ─── */
    const copyTo = (text: string, field: string) => {
        navigator.clipboard.writeText(text);
        setCopiedField(field);
        setTimeout(() => setCopiedField(''), 2000);
    };

    const formatBalance = (sat: number) => (sat / 100000000).toFixed(8);

    const apiFetch = async (method: string, endpoint: string, body?: any) => {
        const url = `${nodeUrl}${endpoint}`;
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error(`API Error: ${res.status}`);
        return await res.json();
    };

    /* ─── Initialization ─── */
    const loadState = useCallback(async () => {
        // Load node URL
        const savedNode = localStorage.getItem(NODE_URL_KEY);
        if (savedNode) setNodeUrl(savedNode);

        // Load wallet
        const savedWallet = localStorage.getItem(STORAGE_KEY);
        if (savedWallet) {
            try {
                const w = JSON.parse(savedWallet);
                setWallet(w);
                setStep('dashboard');
                return w.address;
            } catch (e) {
                console.error("Failed to parse local wallet");
                setStep('welcome');
            }
        } else {
            setStep('welcome');
        }
        return null;
    }, []);

    const fetchBalances = useCallback(async (address: string) => {
        try {
            const res = await apiFetch('GET', `/api/address/${address}/balance`);
            if (res?.success) {
                setWallet(prev => prev ? { ...prev, balance: res.balance } : prev);
            }
        } catch (e) {
            console.error("Failed to fetch balance");
        }
    }, [nodeUrl]);

    const fetchChainInfo = useCallback(async () => {
        try {
            const res = await apiFetch('GET', '/api/blockchain/info');
            if (res) setChainInfo(res);
        } catch { }
    }, [nodeUrl]);

    useEffect(() => {
        loadState().then(addr => {
            if (addr) {
                fetchBalances(addr);
                fetchChainInfo();
            }
        });
    }, [loadState]);

    // Interval fetch
    useEffect(() => {
        if (step !== 'dashboard' || !wallet) return;
        const i = setInterval(() => {
            fetchBalances(wallet.address);
            fetchChainInfo();
        }, 5000);
        return () => clearInterval(i);
    }, [step, wallet, fetchBalances, fetchChainInfo]);

    /* ─── Create Wallet ─── */
    const handleCreate = async () => {
        setStep('creating');
        try {
            const w = await createWallet();
            // Store temporarily in state until verified
            const tempWallet: WalletInfo = {
                address: w.address,
                publicKey: w.publicKey,
                privateKey: w.privateKey,
                mnemonic: w.mnemonic,
                balance: 0
            };
            setWallet(tempWallet);
            setMnemonic(w.mnemonic);

            // Pick 3 random indices
            const words = w.mnemonic.split(' ');
            const indices: number[] = [];
            while (indices.length < 3) {
                const idx = Math.floor(Math.random() * words.length);
                if (!indices.includes(idx)) indices.push(idx);
            }
            setVerifyIndices(indices.sort((a, b) => a - b));
            setVerifyAnswers([null, null, null]);

            setTimeout(() => setStep('mnemonic-display'), 1500);
        } catch (e) {
            console.error(e);
            setStep('welcome');
        }
    };

    const handleVerifyComplete = () => {
        if (!wallet) return;
        const words = mnemonic.split(' ');
        const isValid = verifyIndices.every((idx, i) => words[idx] === verifyAnswers[i]);
        if (isValid) {
            // Save to localStorage
            localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
            setStep('dashboard');
        } else {
            setVerifyError("Incorrect words. Please double check your backup.");
            setTimeout(() => setVerifyError(""), 3000);
        }
    };

    /* ─── Import Wallet ─── */
    const handleImport = async () => {
        if (!importPhrase.trim()) {
            setImportError("Please enter your 12-word recovery phrase");
            return;
        }
        setStep('import-verifying');
        try {
            const w = restoreWallet(importPhrase.trim());
            const newWallet: WalletInfo = {
                address: w.address,
                publicKey: w.publicKey,
                privateKey: w.privateKey,
                mnemonic: importPhrase.trim(),
                balance: 0
            };
            setWallet(newWallet);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(newWallet));
            await fetchBalances(w.address);
            setStep('dashboard');
        } catch (e) {
            console.error(e);
            setStep('import');
            setImportError("Invalid recovery phrase. Please check for typos.");
        }
    };

    /* ─── Send Transaction ─── */
    const handleSendPhaseFlow = async () => {
        if (sendPhase === 'form') {
            if (!sendTo || !sendAmount) return;
            const amt = parseInt(sendAmount);
            if (isNaN(amt) || amt <= 0 || (wallet && amt > wallet.balance)) return;
            setSendPhase('review');
        } else if (sendPhase === 'review') {
            if (!wallet) return;
            setSendPhase('sending');
            try {
                // 1. Fetch UTXOs
                const utxoRes = await apiFetch('GET', `/api/address/${wallet.address}/utxos`);
                if (!utxoRes || !utxoRes.success) throw new Error("Could not fetch UTXOs");

                // 2. Build and sign locally
                const privBytes = new Uint8Array(wallet.privateKey.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
                const pubBytes = new Uint8Array(wallet.publicKey.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

                const { rawHex, txid } = await buildAndSignTransaction(
                    utxoRes.utxos,
                    sendTo,
                    parseInt(sendAmount),
                    privBytes,
                    pubBytes,
                    wallet.address
                );

                // 3. Broadcast
                const bRes = await apiFetch('POST', '/api/transactions/broadcast', { rawTx: rawHex });
                if (bRes && bRes.success) {
                    setSendResult({ success: true, hash: bRes.txid || txid });
                } else {
                    setSendResult({ success: false, error: bRes?.error || "Broadcast rejected" });
                }
            } catch (e: any) {
                setSendResult({ success: false, error: e.message || "Failed to create transaction" });
            }
            setSendPhase('receipt');
        } else if (sendPhase === 'receipt') {
            setSendTo('');
            setSendAmount('');
            setSendPhase('form');
            setSendResult(null);
            setDashTab('overview');
            if (wallet) fetchBalances(wallet.address);
        }
    };

    /* ─── Reset / Logout ─── */
    const handleReset = () => {
        if (!confirmReset) {
            setConfirmReset(true);
            setTimeout(() => setConfirmReset(false), 3000);
            return;
        }
        localStorage.removeItem(STORAGE_KEY);
        setWallet(null);
        setStep('welcome');
        setConfirmReset(false);
    };

    const handleSaveNode = () => {
        localStorage.setItem(NODE_URL_KEY, nodeUrl);
        if (wallet) fetchBalances(wallet.address);
        setCopiedField('nodeUrl');
        setTimeout(() => setCopiedField(''), 2000);
    };

    /* ─── Render Helpers ─── */
    const MnemonicGrid = ({ phrase, clickable = false, fillable = false }: { phrase?: string, clickable?: boolean, fillable?: boolean }) => {
        const words = phrase ? phrase.split(' ') : new Array(10).fill('');
        return (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
                {words.map((w, i) => (
                    <div key={i}
                        className={`
                            relative flex items-center p-3 rounded-lg border text-sm font-medium transition-colors
                            ${fillable && verifyIndices.includes(i)
                                ? verifyAnswers[verifyIndices.indexOf(i)]
                                    ? 'bg-blue-500/10 border-blue-500/30 text-blue-400 focus-within:bg-blue-500/20 focus-within:border-blue-500/50'
                                    : 'bg-zinc-800/50 border-zinc-700 border-dashed text-zinc-500 focus-within:bg-zinc-800 focus-within:border-zinc-500 focus-within:text-zinc-300'
                                : 'bg-zinc-800 border-zinc-700 text-zinc-300'}
                        `}
                    >
                        <span className="absolute -top-2 -left-2 w-5 h-5 flex items-center justify-center bg-zinc-700 text-[10px] rounded-full text-zinc-400 z-10">
                            {i + 1}
                        </span>
                        <div className="w-full text-center">
                            {fillable && verifyIndices.includes(i) ? (
                                <input
                                    type="text"
                                    value={verifyAnswers[verifyIndices.indexOf(i)] || ''}
                                    onChange={(e) => {
                                        const newAns = [...verifyAnswers];
                                        newAns[verifyIndices.indexOf(i)] = e.target.value.trim().toLowerCase();
                                        setVerifyAnswers(newAns);
                                    }}
                                    placeholder="Type word..."
                                    className="w-full bg-transparent border-none text-center outline-none focus:ring-0 placeholder:text-zinc-600 text-inherit"
                                />
                            ) : w}
                        </div>
                    </div>
                ))}
            </div>
        );
    };

    /* ─── Full Renders ─── */
    if (step === 'loading') {
        return (
            <div className="min-h-screen bg-black text-zinc-100 p-8 flex flex-col justify-center items-center font-sans tracking-tight">
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} className="mb-4">
                    <Loader2 className="w-8 h-8 text-blue-500" />
                </motion.div>
                <div className="text-zinc-500 text-sm">Initializing Secure Environment...</div>
            </div>
        );
    }

    if (step === 'welcome') {
        return (
            <div className="min-h-screen bg-black text-zinc-100 p-8 flex flex-col justify-center items-center font-sans tracking-tight overflow-hidden relative">
                {/* Background effects */}
                <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none" />

                <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="z-10 w-full max-w-md">
                    <div className="mb-12 text-center">
                        <div className="w-20 h-20 bg-gradient-to-tr from-blue-600 to-cyan-400 rounded-3xl mx-auto mb-6 flex items-center justify-center shadow-2xl shadow-blue-500/20 rotate-12">
                            <WalletMinimal className="w-10 h-10 text-white -rotate-12" />
                        </div>
                        <h1 className="text-4xl font-semibold mb-3 tracking-tighter">Welcome to Bucks</h1>
                        <p className="text-zinc-400 text-lg">The secure, client-side gateway to the distributed economy.</p>
                    </div>

                    <div className="space-y-4">
                        <button
                            onClick={handleCreate}
                            className="group relative w-full flex items-center p-5 bg-zinc-900 border border-zinc-800 rounded-2xl hover:bg-zinc-800 transition-all overflow-hidden"
                        >
                            <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                            <div className="w-12 h-12 bg-blue-500/10 rounded-xl flex items-center justify-center mr-4 text-blue-400">
                                <Plus className="w-6 h-6" />
                            </div>
                            <div className="text-left flex-1">
                                <div className="font-medium text-lg text-white">Create New Wallet</div>
                                <div className="text-zinc-500 text-sm mt-0.5">Generate a new 10-word phrase</div>
                            </div>
                            <ArrowRight className="w-5 h-5 text-zinc-600 group-hover:text-blue-400 transition-colors" />
                        </button>

                        <button
                            onClick={() => setStep('import')}
                            className="group relative w-full flex items-center p-5 bg-zinc-900 border border-zinc-800 rounded-2xl hover:bg-zinc-800 transition-all"
                        >
                            <div className="w-12 h-12 bg-purple-500/10 rounded-xl flex items-center justify-center mr-4 text-purple-400">
                                <Import className="w-6 h-6" />
                            </div>
                            <div className="text-left flex-1">
                                <div className="font-medium text-lg text-white">Import Existing Wallet</div>
                                <div className="text-zinc-500 text-sm mt-0.5">Restore using recovery phrase</div>
                            </div>
                            <ArrowRight className="w-5 h-5 text-zinc-600 group-hover:text-purple-400 transition-colors" />
                        </button>
                    </div>
                </motion.div>
            </div>
        );
    }

    if (step === 'creating' || step === 'import-verifying') {
        const isImport = step === 'import-verifying';
        return (
            <div className="min-h-screen bg-black text-zinc-100 flex flex-col justify-center items-center">
                <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} className="mb-8">
                    <div className="w-16 h-16 rounded-full border-4 border-zinc-800 border-t-blue-500" />
                </motion.div>
                <h2 className="text-2xl font-medium mb-3">{isImport ? 'Restoring Wallet' : 'Generating Keys'}</h2>
                <p className="text-zinc-500 flex items-center gap-2">
                    <Shield className="w-4 h-4" /> Client-side secp256k1 ECDSA
                </p>
            </div>
        );
    }

    if (step === 'import') {
        return (
            <div className="min-h-screen bg-black text-zinc-100 p-8 flex flex-col justify-center items-center font-sans">
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-lg">
                    <button onClick={() => setStep('welcome')} className="flex items-center text-zinc-500 hover:text-white mb-8 transition-colors">
                        <ArrowLeft className="w-4 h-4 mr-2" /> Back
                    </button>

                    <h2 className="text-3xl font-semibold mb-3">Import from Mnemonic</h2>
                    <p className="text-zinc-400 mb-8">Type or paste your 10-word recovery phrase to restore your wallet locally.</p>

                    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 mb-6">
                        <textarea
                            value={importPhrase}
                            onChange={(e) => {
                                setImportPhrase(e.target.value);
                                setImportError('');
                            }}
                            placeholder="word1 word2 word3..."
                            className="w-full h-32 bg-transparent border-none text-white focus:ring-0 resize-none font-medium leading-relaxed placeholder:text-zinc-700"
                        />
                    </div>

                    {importError && (
                        <div className="flex items-center gap-2 text-red-400 bg-red-500/10 p-4 rounded-xl mb-6 border border-red-500/20">
                            <AlertTriangle className="w-5 h-5" /> {importError}
                        </div>
                    )}

                    <button
                        onClick={handleImport}
                        disabled={!importPhrase.trim()}
                        className="w-full bg-white text-black font-semibold py-4 rounded-xl hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        Restore Wallet
                    </button>
                </motion.div>
            </div>
        );
    }

    if (step === 'mnemonic-display') {
        return (
            <div className="min-h-screen bg-black text-zinc-100 p-8 flex flex-col items-center py-20 font-sans">
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-2xl">
                    <div className="flex items-center gap-3 mb-8">
                        <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold text-sm">1</div>
                        <div className="h-1 flex-1 bg-zinc-800 rounded-full"><div className="h-full w-1/2 bg-blue-500 rounded-full" /></div>
                        <div className="w-8 h-8 rounded-full bg-zinc-800 text-zinc-500 flex items-center justify-center font-bold text-sm">2</div>
                    </div>

                    <h2 className="text-3xl font-semibold mb-3">Secure your Recovery Phrase</h2>
                    <p className="text-zinc-400 mb-8 max-w-lg">Write down these 10 words in order. This is the <strong className="text-white">only</strong> way to recover your wallet if you lose access to this browser.</p>

                    <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex gap-4 mb-8">
                        <AlertTriangle className="w-6 h-6 text-red-400 shrink-0" />
                        <div>
                            <div className="font-medium text-red-200 mb-1">Never share this phrase</div>
                            <div className="text-red-400/80 text-sm leading-relaxed">Anyone with this phrase has full access to your funds. The Bucks node does not store this.</div>
                        </div>
                    </div>

                    <MnemonicGrid phrase={mnemonic} />

                    <div className="flex gap-4">
                        <button
                            onClick={() => copyTo(mnemonic, 'mnemonic')}
                            className="flex items-center justify-center gap-2 p-4 bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800 transition-colors shrink-0 text-white"
                        >
                            {copiedField === 'mnemonic' ? <Check className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5" />}
                        </button>
                        <button
                            onClick={() => setStep('mnemonic-verify')}
                            className="flex-1 bg-white text-black font-semibold py-4 rounded-xl hover:bg-zinc-200 transition-colors"
                        >
                            I've Saved It
                        </button>
                    </div>
                </motion.div>
            </div>
        );
    }

    if (step === 'mnemonic-verify') {
        const canSubmit = verifyAnswers.every(a => a !== null && a.trim() !== '');
        return (
            <div className="min-h-screen bg-black text-zinc-100 p-8 flex flex-col items-center py-20 font-sans">
                <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="w-full max-w-2xl">
                    <div className="flex items-center gap-3 mb-8">
                        <div className="w-8 h-8 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-sm"><Check className="w-4 h-4" /></div>
                        <div className="h-1 flex-1 bg-zinc-800 rounded-full"><div className="h-full w-full bg-blue-500 rounded-full" /></div>
                        <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold text-sm">2</div>
                    </div>

                    <h2 className="text-3xl font-semibold mb-3">Verify Recovery Phrase</h2>
                    <p className="text-zinc-400 mb-8">Tap the empty boxes and enter the missing words to prove you saved them.</p>

                    <MnemonicGrid phrase={mnemonic} fillable={true} />

                    {verifyError && (
                        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 text-red-400 bg-red-500/10 p-4 rounded-xl mb-6 border border-red-500/20">
                            <AlertTriangle className="w-5 h-5" /> {verifyError}
                        </motion.div>
                    )}

                    <div className="flex gap-4">
                        <button
                            onClick={() => setStep('mnemonic-display')}
                            className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl hover:bg-zinc-800 transition-colors shrink-0 text-white"
                        >
                            <ArrowLeft className="w-5 h-5" />
                        </button>
                        <button
                            onClick={handleVerifyComplete}
                            disabled={!canSubmit}
                            className="flex-1 bg-white text-black font-semibold py-4 rounded-xl hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Verify & Complete
                        </button>
                    </div>
                </motion.div>
            </div>
        );
    }

    if (step === 'dashboard' && wallet) {
        return (
            <div className="min-h-screen bg-[#050505] text-zinc-100 p-6 md:p-8 font-sans">
                <div className="max-w-5xl mx-auto">
                    {/* Header */}
                    <header className="flex items-center justify-between mb-8">
                        <div className="flex items-center gap-3">
                            <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20">
                                <WalletMinimal className="w-6 h-6 text-white" />
                            </div>
                            <div>
                                <h1 className="text-xl font-bold">Client Wallet</h1>
                                <div className="text-sm text-zinc-500">Connected to {nodeUrl.includes('localhost') ? 'Local Node' : 'Remote Node'}</div>
                            </div>
                        </div>

                        <div className="flex items-center gap-3">
                            <button
                                onClick={handleReset}
                                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${confirmReset ? 'bg-red-500 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800'}`}
                            >
                                <LogOut className="w-4 h-4" />
                                {confirmReset ? 'Click again to wipe' : 'Reset Wallet'}
                            </button>
                        </div>
                    </header>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                        {/* Left Col - Card & Tabs */}
                        <div className="lg:col-span-2 space-y-8">
                            {/* Balance Card */}
                            <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="relative bg-gradient-to-br from-blue-600 to-indigo-900 rounded-3xl p-8 overflow-hidden shadow-2xl shadow-blue-900/20">
                                <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none" />
                                <div className="relative z-10 flex flex-col h-full justify-between">
                                    <div className="mb-8">
                                        <div className="text-blue-200 font-medium mb-1">Total Balance</div>
                                        <div className="flex items-baseline gap-2">
                                            <span className="text-5xl font-bold tracking-tight text-white">{formatBalance(wallet.balance)}</span>
                                            <span className="text-xl font-medium text-blue-200">BUCKS</span>
                                        </div>
                                    </div>

                                    <div className="flex items-center justify-between">
                                        <div className="flex gap-3">
                                            <button onClick={() => setDashTab('send')} className="bg-white text-blue-900 px-6 py-3 rounded-xl font-semibold flex items-center gap-2 hover:bg-blue-50 transition-colors shadow-lg">
                                                <ArrowDownLeft className="w-4 h-4" /> Send
                                            </button>
                                            <button onClick={() => setDashTab('receive')} className="bg-blue-500/30 text-white px-6 py-3 rounded-xl font-semibold flex items-center gap-2 hover:bg-blue-500/40 border border-blue-400/30 transition-colors">
                                                <ArrowUpRightIcon className="w-4 h-4" /> Receive
                                            </button>
                                        </div>
                                        {chainInfo && (
                                            <div className="text-right">
                                                <div className="text-blue-200 text-sm">Block Height</div>
                                                <div className="text-white font-medium">{chainInfo.height?.toLocaleString() || 0}</div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </motion.div>

                            {/* Tabs Navigation */}
                            <div className="flex overflow-x-auto hide-scrollbar gap-2 border-b border-zinc-800 pb-2">
                                {[
                                    { id: 'overview', label: 'Overview', icon: WalletMinimal },
                                    { id: 'send', label: 'Send', icon: Send },
                                    { id: 'receive', label: 'Receive', icon: QrCode },
                                    { id: 'keys', label: 'Keys & Security', icon: Key },
                                    { id: 'network', label: 'Network', icon: Server }
                                ].map(t => (
                                    <button
                                        key={t.id}
                                        onClick={() => setDashTab(t.id as DashboardTab)}
                                        className={`flex items-center gap-2 px-5 py-3 rounded-xl font-medium transition-all whitespace-nowrap ${dashTab === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'}`}
                                    >
                                        <t.icon className="w-4 h-4" /> {t.label}
                                    </button>
                                ))}
                            </div>

                            {/* Tab Content */}
                            <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-6 md:p-8 min-h-[400px]">
                                <AnimatePresence mode="wait">
                                    <motion.div
                                        key={dashTab}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -10 }}
                                        transition={{ duration: 0.2 }}
                                    >
                                        {/* -- Overview Tab -- */}
                                        {dashTab === 'overview' && (
                                            <div className="space-y-6">
                                                <h3 className="text-xl font-semibold mb-4">Quick Actions</h3>
                                                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                                                    <ActionCard icon={Send} label="Send BUCKS" desc="Transfer to another address" onClick={() => setDashTab('send')} />
                                                    <ActionCard icon={QrCode} label="Receive" desc="View your address" onClick={() => setDashTab('receive')} />
                                                    <ActionCard icon={Key} label="Manage Keys" desc="View private key/phrase" onClick={() => setDashTab('keys')} />
                                                    <ActionCard icon={Pickaxe} label="Miner Stats" desc="Go to mining dashboard" onClick={() => router.push('/mining')} />
                                                </div>

                                                <h3 className="text-xl font-semibold mt-8 mb-4">Network Info</h3>
                                                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
                                                    <div><div className="text-zinc-500 text-sm mb-1">Status</div><div className="flex items-center gap-2 text-green-400 font-medium"><div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />Online</div></div>
                                                    <div><div className="text-zinc-500 text-sm mb-1">Node URL</div><div className="text-white font-medium truncate">{nodeUrl}</div></div>
                                                    <div><div className="text-zinc-500 text-sm mb-1">Peers</div><div className="text-white font-medium">{chainInfo?.peers || 0} connected</div></div>
                                                    <div><div className="text-zinc-500 text-sm mb-1">Difficulty</div><div className="text-white font-medium">{chainInfo?.difficulty || 'N/A'}</div></div>
                                                </div>
                                            </div>
                                        )}

                                        {/* -- Send Tab -- */}
                                        {dashTab === 'send' && (
                                            <div className="max-w-md mx-auto py-4">
                                                {/* Phases: form -> review -> sending -> receipt */}

                                                {sendPhase === 'form' && (
                                                    <div className="space-y-5">
                                                        <h3 className="text-2xl font-semibold text-center mb-6">Send BUCKS</h3>
                                                        <div>
                                                            <label className="block text-sm font-medium text-zinc-400 mb-2">Recipient Address</label>
                                                            <input type="text" value={sendTo} onChange={e => setSendTo(e.target.value)} placeholder="00..." className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-3 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all outline-none font-mono text-sm" />
                                                        </div>
                                                        <div>
                                                            <label className="block text-sm font-medium text-zinc-400 mb-2">Amount (Satoshis)</label>
                                                            <div className="relative">
                                                                <input type="number" value={sendAmount} onChange={e => setSendAmount(e.target.value)} placeholder="100000000" className="w-full bg-zinc-900 border border-zinc-700 rounded-xl pl-4 pr-16 py-3 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all outline-none font-mono text-sm" />
                                                                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 font-medium text-sm">sats</div>
                                                            </div>
                                                            <div className="text-right text-xs text-zinc-500 mt-2">Available: {wallet?.balance?.toLocaleString() || 0} sats</div>
                                                        </div>
                                                        <button
                                                            onClick={handleSendPhaseFlow}
                                                            disabled={!sendTo || !sendAmount || isNaN(parseInt(sendAmount)) || parseInt(sendAmount) <= 0 || parseInt(sendAmount) > wallet.balance}
                                                            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-4 rounded-xl transition-colors mt-4 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                                        >
                                                            Review Transaction <ArrowRight className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                )}

                                                {sendPhase === 'review' && (
                                                    <div className="space-y-6">
                                                        <h3 className="text-2xl font-semibold text-center mb-2">Review</h3>
                                                        <div className="bg-zinc-900 border border-zinc-800 p-5 rounded-2xl space-y-4">
                                                            <div>
                                                                <div className="text-zinc-500 text-sm mb-1">To</div>
                                                                <div className="font-mono text-sm text-white break-all">{sendTo}</div>
                                                            </div>
                                                            <div className="h-px bg-zinc-800 w-full" />
                                                            <div>
                                                                <div className="text-zinc-500 text-sm mb-1">Amount</div>
                                                                <div className="text-2xl font-bold text-white">{parseInt(sendAmount || "0").toLocaleString()} <span className="text-base font-normal text-zinc-400">sats</span></div>
                                                                <div className="text-sm text-zinc-500">≈ {formatBalance(parseInt(sendAmount || "0"))} BUCKS</div>
                                                            </div>
                                                            <div className="h-px bg-zinc-800 w-full" />
                                                            <div>
                                                                <div className="text-zinc-500 text-sm mb-1">Network Fee</div>
                                                                <div className="text-white text-sm">Calculated dynamically (min 100,000 sats)</div>
                                                            </div>
                                                        </div>
                                                        <div className="flex gap-3">
                                                            <button onClick={() => setSendPhase('form')} className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-4 rounded-xl transition-colors">Cancel</button>
                                                            <button onClick={handleSendPhaseFlow} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-4 rounded-xl transition-colors flex items-center justify-center gap-2">Confirm & Send <Send className="w-4 h-4" /></button>
                                                        </div>
                                                    </div>
                                                )}

                                                {sendPhase === 'sending' && (
                                                    <div className="flex flex-col items-center justify-center py-12">
                                                        <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 2, ease: "linear" }} className="w-20 h-20 border-4 border-zinc-800 border-t-blue-500 rounded-full mb-6" />
                                                        <h3 className="text-xl font-medium mb-2">Signing & Broadcasting...</h3>
                                                        <p className="text-zinc-400 text-sm text-center max-w-xs">Building transaction, signing with local private key, and broadcasting to the P2P network.</p>
                                                    </div>
                                                )}

                                                {sendPhase === 'receipt' && sendResult && (
                                                    <div className="flex flex-col items-center py-6 text-center">
                                                        {sendResult.success ? (
                                                            <>
                                                                <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mb-6">
                                                                    <CheckCircle className="w-10 h-10 text-green-500" />
                                                                </div>
                                                                <h3 className="text-2xl font-semibold mb-2 text-white">Transaction Sent</h3>
                                                                <p className="text-zinc-400 mb-6">Your transaction was signed and broadcasted.</p>
                                                                <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-xl w-full mb-8 text-left">
                                                                    <div className="text-zinc-500 text-xs mb-1 uppercase tracking-wider">Transaction Hash</div>
                                                                    <div className="font-mono text-xs text-blue-400 break-all">{sendResult.hash}</div>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mb-6">
                                                                    <AlertTriangle className="w-10 h-10 text-red-500" />
                                                                </div>
                                                                <h3 className="text-2xl font-semibold mb-2 text-white">Transaction Failed</h3>
                                                                <p className="text-red-400 mb-8 max-w-sm">{sendResult.error}</p>
                                                            </>
                                                        )}
                                                        <button onClick={handleSendPhaseFlow} className="bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-3 px-8 rounded-xl transition-colors">Done</button>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* -- Receive Tab -- */}
                                        {dashTab === 'receive' && (
                                            <div className="flex flex-col items-center py-8">
                                                <div className="bg-white p-4 rounded-2xl mb-8">
                                                    {/* Fake QR code for aesthetic */}
                                                    <div className="w-48 h-48 bg-black rounded-lg flex items-center justify-center">
                                                        <QrCode className="w-32 h-32 text-white/20" />
                                                    </div>
                                                </div>
                                                <div className="text-center mb-6">
                                                    <h3 className="text-xl font-semibold mb-1">Your P2PKH Address</h3>
                                                    <p className="text-zinc-400 text-sm max-w-xs">Send only BUCKS on the native network to this address.</p>
                                                </div>
                                                <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-4 flex items-center gap-4 max-w-md w-full">
                                                    <div className="font-mono text-sm text-white truncate flex-1">{wallet.address}</div>
                                                    <button onClick={() => copyTo(wallet.address, 'recv')} className="text-zinc-400 hover:text-white transition-colors bg-zinc-800 p-2 rounded-lg">
                                                        {copiedField === 'recv' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {/* -- Keys Tab -- */}
                                        {dashTab === 'keys' && (
                                            <div className="space-y-6">
                                                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex gap-4">
                                                    <Shield className="w-6 h-6 text-red-400 shrink-0" />
                                                    <div>
                                                        <div className="font-medium text-red-200 mb-1">Security Warning</div>
                                                        <div className="text-red-400/80 text-sm">Never share your private key or recovery phrase. Bucks staff will never ask for them. These keys are generated and stored locally in your browser.</div>
                                                    </div>
                                                </div>

                                                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
                                                    <div className="p-5 border-b border-zinc-800">
                                                        <div className="text-zinc-500 text-sm mb-2">Public Key (Compressed)</div>
                                                        <div className="flex items-center gap-3">
                                                            <div className="font-mono text-sm text-white break-all">{wallet.publicKey}</div>
                                                            <button onClick={() => copyTo(wallet.publicKey, 'pub')} className="text-zinc-500 hover:text-white shrink-0">
                                                                {copiedField === 'pub' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                                                            </button>
                                                        </div>
                                                    </div>

                                                    <div className="p-5 border-b border-zinc-800 bg-zinc-900/50">
                                                        <div className="flex justify-between items-end mb-2">
                                                            <div className="text-zinc-500 text-sm">Private Key (Hex)</div>
                                                            <button onClick={() => setShowPrivateKey(!showPrivateKey)} className="text-blue-400 text-xs font-medium hover:text-blue-300 flex items-center gap-1">
                                                                {showPrivateKey ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> Reveal</>}
                                                            </button>
                                                        </div>
                                                        <div className="flex items-center gap-3">
                                                            <div className={`font-mono text-sm break-all ${showPrivateKey ? 'text-white' : 'text-zinc-700 select-none blur-[4px]'}`}>
                                                                {showPrivateKey ? wallet.privateKey : '•'.repeat(64)}
                                                            </div>
                                                            <button onClick={() => copyTo(wallet.privateKey, 'priv')} disabled={!showPrivateKey} className={`shrink-0 ${showPrivateKey ? 'text-zinc-500 hover:text-white' : 'text-zinc-800 cursor-not-allowed'}`}>
                                                                {copiedField === 'priv' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                                                            </button>
                                                        </div>
                                                    </div>

                                                    {wallet.mnemonic && (
                                                        <div className="p-5 relative">
                                                            <div className="flex justify-between items-center mb-4">
                                                                <div className="text-zinc-500 text-sm">Recovery Phrase</div>
                                                                <button onClick={() => setShowMnemonic(!showMnemonic)} className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white">
                                                                    {showMnemonic ? 'Hide Phrase' : 'View Phrase'} {showMnemonic ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                                </button>
                                                            </div>
                                                            {showMnemonic && (
                                                                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                                                                    <MnemonicGrid phrase={wallet.mnemonic} />
                                                                    <button onClick={() => copyTo(wallet.mnemonic!, 'phrase')} className="w-full flex items-center justify-center gap-2 py-3 bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors text-sm font-medium">
                                                                        {copiedField === 'phrase' ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />} Copy Phrase
                                                                    </button>
                                                                </motion.div>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {/* -- Network Tab -- */}
                                        {dashTab === 'network' && (
                                            <div className="space-y-6 max-w-lg">
                                                <h3 className="text-2xl font-semibold mb-2">Node Connection</h3>
                                                <p className="text-zinc-400 mb-6 font-medium">Specify the node you want this client wallet to connect to for fetching balances and broadcasting transactions.</p>

                                                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 mb-6">
                                                    <label className="block text-sm font-medium text-zinc-500 mb-2">Remote API Node URL</label>
                                                    <div className="flex gap-3">
                                                        <input
                                                            type="text"
                                                            value={nodeUrl}
                                                            onChange={e => setNodeUrl(e.target.value)}
                                                            placeholder="http://localhost:8080"
                                                            className="flex-1 bg-black border border-zinc-700 rounded-xl px-4 py-3 text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all outline-none font-mono text-sm"
                                                        />
                                                        <button
                                                            onClick={handleSaveNode}
                                                            className="bg-blue-600 hover:bg-blue-500 text-white font-semibold px-6 py-3 rounded-xl transition-colors shrink-0"
                                                        >
                                                            {copiedField === 'nodeUrl' ? <Check className="w-5 h-5 mx-auto" /> : 'Save & Connect'}
                                                        </button>
                                                    </div>
                                                </div>

                                                <div className="bg-blue-500/10 border border-blue-500/20 text-blue-300 p-4 rounded-xl text-sm leading-relaxed">
                                                    <strong>Decentralization Note:</strong> Because your keys are managed entirely in the browser, you can safely connect to any node. The node never sees your private key, it only receives signed transactions.
                                                </div>
                                            </div>
                                        )}
                                    </motion.div>
                                </AnimatePresence>
                            </div>
                        </div>

                        {/* Right Col - Activity / Extras */}
                        <div className="space-y-6">
                            <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-6">
                                <h3 className="font-semibold mb-6 flex items-center justify-between">
                                    Recent Activity <RefreshCw className="w-4 h-4 text-zinc-500" />
                                </h3>
                                <div className="space-y-4">
                                    {/* Mock activity for now until mempool/tx history API is solid */}
                                    <div className="text-center py-10 text-zinc-500 text-sm">
                                        No recent transactions.
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return null;
}

const ActionCard = ({ icon: Icon, label, desc, onClick }: any) => (
    <button onClick={onClick} className="bg-zinc-900 border border-zinc-800 p-5 rounded-2xl hover:bg-zinc-800 hover:border-zinc-700 transition-all text-left flex flex-col items-start group">
        <div className="w-10 h-10 bg-zinc-800 rounded-xl flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
            <Icon className="w-5 h-5 text-zinc-300" />
        </div>
        <div className="font-semibold text-white mb-1">{label}</div>
        <div className="text-xs text-zinc-500 leading-relaxed">{desc}</div>
    </button>
);

function ArrowUpRightIcon(props: any) {
    return (
        <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7h10v10" /><path d="M7 17 17 7" />
        </svg>
    );
}

