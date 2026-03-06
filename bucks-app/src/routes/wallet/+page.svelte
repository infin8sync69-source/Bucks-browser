<script lang="ts">
    import { onMount } from "svelte";
    import { fade, scale, fly } from "svelte/transition";
    import {
        Wallet,
        Copy,
        Check,
        ArrowRight,
        Shield,
        Pickaxe,
        RefreshCw,
        Eye,
        EyeOff,
        Send,
        QrCode,
        Key,
        ArrowDownLeft,
        ChevronDown,
        ChevronUp,
        LogOut,
        Plus,
        Import,
        AlertTriangle,
        ArrowLeft,
        Loader2,
        CheckCircle,
        Server,
    } from "lucide-svelte";
    import {
        createWallet,
        restoreWallet,
        buildAndSignTransaction,
    } from "$lib/bucks-crypto";
    import type { UTXO } from "$lib/bucks-crypto";

    type WalletInfo = {
        address: string;
        balance: number;
        publicKey: string;
        privateKey: string;
        mnemonic?: string;
    };

    type FlowStep =
        | "loading"
        | "welcome"
        | "creating"
        | "mnemonic-display"
        | "mnemonic-verify"
        | "import"
        | "import-verifying"
        | "dashboard";
    type DashboardTab = "overview" | "send" | "receive" | "keys" | "network";
    type SendPhase = "form" | "review" | "sending" | "receipt";

    const STORAGE_KEY = "bucks_wallet_v2";
    const NODE_URL_KEY = "bucks_node_url";
    const DEFAULT_NODE_URL = "http://localhost:8080";

    // State (Svelte 5 Runes)
    let step = $state<FlowStep>("loading");
    let wallet = $state<WalletInfo | null>(null);
    let nodeUrl = $state(DEFAULT_NODE_URL);
    let chainInfo = $state<any>(null);
    let dashTab = $state<DashboardTab>("overview");

    let mnemonic = $state("");
    let verifyIndices = $state<number[]>([]);
    let verifyAnswers = $state<(string | null)[]>([null, null, null]);
    let verifyError = $state("");

    let importPhrase = $state("");
    let importError = $state("");

    let sendTo = $state("");
    let sendAmount = $state("");
    let sendPhase = $state<SendPhase>("form");
    let sendResult = $state<{
        success: boolean;
        hash?: string;
        error?: string;
    } | null>(null);

    let showPrivateKey = $state(false);
    let copiedField = $state("");
    let confirmReset = $state(false);

    // Helpers
    function copyTo(text: string, field: string) {
        navigator.clipboard.writeText(text);
        copiedField = field;
        setTimeout(() => (copiedField = ""), 2000);
    }

    const formatBalance = (sat: number) => (sat / 100000000).toFixed(8);

    async function apiFetch(method: string, endpoint: string, body?: any) {
        try {
            const url = `${nodeUrl}${endpoint}`;
            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
            });
            if (!res.ok) throw new Error(`API Error: ${res.status}`);
            return await res.json();
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    async function fetchBalances() {
        if (!wallet) return;
        const res = await apiFetch(
            "GET",
            `/api/address/${wallet.address}/balance`,
        );
        if (res?.success) {
            wallet.balance = res.balance;
        }
    }

    async function fetchChainInfo() {
        const res = await apiFetch("GET", "/api/blockchain/info");
        if (res) chainInfo = res;
    }

    onMount(() => {
        const savedNode = localStorage.getItem(NODE_URL_KEY);
        if (savedNode) nodeUrl = savedNode;

        const savedWallet = localStorage.getItem(STORAGE_KEY);
        if (savedWallet) {
            try {
                const w = JSON.parse(savedWallet);
                wallet = w;
                step = "dashboard";
                fetchBalances();
                fetchChainInfo();
            } catch (e) {
                console.error("Failed to parse local wallet");
                step = "welcome";
            }
        } else {
            step = "welcome";
        }

        // Interval
        const i = setInterval(() => {
            if (step === "dashboard" && wallet) {
                fetchBalances();
                fetchChainInfo();
            }
        }, 5000);

        return () => clearInterval(i);
    });

    // Create Flow
    async function handleCreate() {
        step = "creating";
        try {
            const w = await createWallet();
            wallet = {
                address: w.address,
                publicKey: w.publicKey,
                privateKey: w.privateKey,
                mnemonic: w.mnemonic,
                balance: 0,
            };
            mnemonic = w.mnemonic;

            const words = w.mnemonic.split(" ");
            const indices: number[] = [];
            while (indices.length < 3) {
                const idx = Math.floor(Math.random() * words.length);
                if (!indices.includes(idx)) indices.push(idx);
            }
            verifyIndices = indices.sort((a, b) => a - b);
            verifyAnswers = [null, null, null];

            setTimeout(() => (step = "mnemonic-display"), 1500);
        } catch (e) {
            console.error(e);
            step = "welcome";
        }
    }

    function handleVerifyComplete() {
        if (!wallet) return;
        const words = mnemonic.split(" ");
        const isValid = verifyIndices.every(
            (idx, i) => words[idx] === verifyAnswers[i],
        );
        if (isValid) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
            step = "dashboard";
        } else {
            verifyError = "Incorrect words. Please double check.";
            setTimeout(() => (verifyError = ""), 3000);
        }
    }

    // Import Flow
    async function handleImport() {
        if (!importPhrase.trim()) {
            importError = "Please enter your 10-word phrase";
            return;
        }
        step = "import-verifying";
        try {
            const w = restoreWallet(importPhrase.trim());
            wallet = {
                address: w.address,
                publicKey: w.publicKey,
                privateKey: w.privateKey,
                mnemonic: importPhrase.trim(),
                balance: 0,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(wallet));
            await fetchBalances();
            step = "dashboard";
        } catch (e) {
            console.error(e);
            step = "import";
            importError = "Invalid recovery phrase.";
        }
    }

    // Reset Flow
    function handleReset() {
        if (!confirmReset) {
            confirmReset = true;
            setTimeout(() => (confirmReset = false), 3000);
            return;
        }
        localStorage.removeItem(STORAGE_KEY);
        wallet = null;
        step = "welcome";
        confirmReset = false;
    }
</script>

<svelte:head>
    <title>Bucks Wallet</title>
</svelte:head>

<div
    class="fixed inset-0 top-16 z-10 w-full overflow-y-auto no-scrollbar pointer-events-auto bg-[#0a0a0c]"
>
    {#if step === "loading"}
        <div
            class="min-h-full flex flex-col justify-center items-center font-sans"
        >
            <Loader2 class="w-8 h-8 text-blue-500 animate-spin mb-4" />
            <div class="text-zinc-500 text-sm">
                Initializing Secure Environment...
            </div>
        </div>
    {:else if step === "welcome"}
        <div
            class="min-h-full flex flex-col justify-center items-center font-sans p-8 relative"
        >
            <div
                class="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-blue-600/10 blur-[120px] rounded-full pointer-events-none"
            ></div>

            <div
                class="z-10 w-full max-w-md"
                in:scale={{ duration: 400, start: 0.95 }}
            >
                <div class="mb-12 text-center">
                    <div
                        class="w-20 h-20 bg-gradient-to-tr from-blue-600 to-cyan-400 rounded-3xl mx-auto mb-6 flex items-center justify-center shadow-2xl shadow-blue-500/20 rotate-12"
                    >
                        <Wallet class="w-10 h-10 text-white -rotate-12" />
                    </div>
                    <h1
                        class="text-4xl font-semibold mb-3 tracking-tighter text-white"
                    >
                        Welcome to Bucks
                    </h1>
                    <p class="text-zinc-400 text-lg">
                        The secure, client-side gateway to the distributed
                        economy.
                    </p>
                </div>

                <div class="space-y-4">
                    <button
                        onclick={handleCreate}
                        class="group relative w-full flex items-center p-5 bg-zinc-900 border border-zinc-800 rounded-2xl hover:bg-zinc-800 transition-all overflow-hidden text-left"
                    >
                        <div
                            class="w-12 h-12 bg-blue-500/10 rounded-xl flex items-center justify-center mr-4 text-blue-400"
                        >
                            <Plus class="w-6 h-6" />
                        </div>
                        <div class="flex-1">
                            <div class="font-medium text-lg text-white">
                                Create New Wallet
                            </div>
                            <div class="text-zinc-500 text-sm mt-0.5">
                                Generate a new 10-word phrase
                            </div>
                        </div>
                        <ArrowRight
                            class="w-5 h-5 text-zinc-600 group-hover:text-blue-400 transition-colors"
                        />
                    </button>

                    <button
                        onclick={() => (step = "import")}
                        class="group relative w-full flex items-center p-5 bg-zinc-900 border border-zinc-800 rounded-2xl hover:bg-zinc-800 transition-all text-left"
                    >
                        <div
                            class="w-12 h-12 bg-purple-500/10 rounded-xl flex items-center justify-center mr-4 text-purple-400"
                        >
                            <Import class="w-6 h-6" />
                        </div>
                        <div class="flex-1">
                            <div class="font-medium text-lg text-white">
                                Import Existing Wallet
                            </div>
                            <div class="text-zinc-500 text-sm mt-0.5">
                                Restore using recovery phrase
                            </div>
                        </div>
                        <ArrowRight
                            class="w-5 h-5 text-zinc-600 group-hover:text-purple-400 transition-colors"
                        />
                    </button>
                </div>
            </div>
        </div>
    {:else if step === "creating" || step === "import-verifying"}
        <div class="min-h-full flex flex-col justify-center items-center">
            <div
                class="mb-8 w-16 h-16 rounded-full border-4 border-zinc-800 border-t-blue-500 animate-spin"
            ></div>
            <h2 class="text-2xl font-medium mb-3 text-white">
                {step === "import-verifying"
                    ? "Restoring Wallet"
                    : "Generating Keys"}
            </h2>
            <p class="text-zinc-500 flex items-center gap-2">
                <Shield class="w-4 h-4" /> Client-side secp256k1 ECDSA
            </p>
        </div>
    {:else if step === "import"}
        <div class="min-h-full flex flex-col justify-center items-center p-8">
            <div class="w-full max-w-lg" in:fade={{ duration: 300 }}>
                <button
                    onclick={() => (step = "welcome")}
                    class="flex items-center text-zinc-500 hover:text-white mb-8 transition-colors"
                >
                    <ArrowLeft class="w-4 h-4 mr-2" /> Back
                </button>
                <h2 class="text-3xl font-semibold mb-3 text-white">
                    Import from Mnemonic
                </h2>
                <p class="text-zinc-400 mb-8">
                    Type or paste your 10-word recovery phrase to restore your
                    wallet locally.
                </p>
                <textarea
                    bind:value={importPhrase}
                    oninput={() => (importError = "")}
                    placeholder="word1 word2 word3..."
                    class="w-full h-32 bg-zinc-900 border border-zinc-800 rounded-2xl p-6 text-white text-lg resize-none mb-6 outline-none focus:border-zinc-500"
                ></textarea>

                {#if importError}
                    <div
                        class="flex items-center gap-2 text-red-400 bg-red-500/10 p-4 rounded-xl mb-6 border border-red-500/20"
                    >
                        <AlertTriangle class="w-5 h-5" />
                        {importError}
                    </div>
                {/if}
                <button
                    onclick={handleImport}
                    disabled={!importPhrase.trim()}
                    class="w-full bg-white text-black font-semibold py-4 rounded-xl hover:bg-zinc-200 transition-colors disabled:opacity-50"
                >
                    Restore Wallet
                </button>
            </div>
        </div>
    {:else if step === "mnemonic-display"}
        <div class="min-h-full flex flex-col items-center py-20 p-8">
            <div class="w-full max-w-2xl" in:fade={{ duration: 300 }}>
                <h2 class="text-3xl font-semibold mb-3 text-white">
                    Secure your Recovery Phrase
                </h2>
                <p class="text-zinc-400 mb-8">
                    Write down these 10 words in order. This is the only way to
                    recover your wallet.
                </p>

                <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
                    {#each mnemonic.split(" ") as word, i}
                        <div
                            class="relative bg-zinc-800 border border-zinc-700 text-zinc-300 p-3 rounded-lg text-center text-sm font-medium"
                        >
                            <span
                                class="absolute -top-2 -left-2 w-5 h-5 bg-zinc-700 text-[10px] rounded-full flex items-center justify-center text-zinc-400 z-10"
                                >{i + 1}</span
                            >
                            {word}
                        </div>
                    {/each}
                </div>

                <div class="flex gap-4">
                    <button
                        onclick={() => copyTo(mnemonic, "mnemonic")}
                        class="p-4 bg-zinc-900 border border-zinc-800 rounded-xl text-white hover:bg-zinc-800 transition-all"
                    >
                        {#if copiedField === "mnemonic"}<Check
                                class="w-5 h-5 text-green-400"
                            />{:else}<Copy class="w-5 h-5" />{/if}
                    </button>
                    <button
                        onclick={() => (step = "mnemonic-verify")}
                        class="flex-1 bg-white text-black font-semibold py-4 rounded-xl hover:bg-zinc-200 transition-colors"
                    >
                        I've Saved It
                    </button>
                </div>
            </div>
        </div>
    {:else if step === "dashboard" && wallet}
        <div class="min-h-full p-8 pb-32">
            <div class="max-w-5xl mx-auto">
                <header class="flex items-center justify-between mb-8">
                    <div class="flex items-center gap-3">
                        <div
                            class="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20"
                        >
                            <Wallet class="w-6 h-6 text-white" />
                        </div>
                        <div>
                            <h1 class="text-xl font-bold text-white">
                                Client Wallet
                            </h1>
                            <div class="text-sm text-zinc-500">Local Node</div>
                        </div>
                    </div>
                    <button
                        onclick={handleReset}
                        class="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors bg-zinc-900 text-zinc-400 hover:text-white border border-zinc-800 {confirmReset
                            ? '!bg-red-500 !text-white'
                            : ''}"
                    >
                        <LogOut class="w-4 h-4" />
                        {confirmReset ? "Click to wipe" : "Reset Wallet"}
                    </button>
                </header>

                <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div class="lg:col-span-2 space-y-8">
                        <!-- Balance Card -->
                        <div
                            class="relative bg-gradient-to-br from-blue-600 to-indigo-900 rounded-3xl p-8 overflow-hidden shadow-2xl shadow-blue-900/20"
                            in:fly={{ y: 20 }}
                        >
                            <div class="mb-8">
                                <div class="text-blue-200 font-medium mb-1">
                                    Total Balance
                                </div>
                                <div class="flex items-baseline gap-2">
                                    <span
                                        class="text-5xl font-bold tracking-tight text-white"
                                        >{formatBalance(
                                            wallet?.balance || 0,
                                        )}</span
                                    >
                                    <span
                                        class="text-xl font-medium text-blue-200"
                                        >BUCKS</span
                                    >
                                </div>
                            </div>
                            <!-- Address Pill -->
                            <div
                                class="inline-flex items-center gap-2 bg-black/20 rounded-full px-4 py-1.5 text-sm font-mono text-white/80"
                            >
                                <span class="truncate max-w-[200px]"
                                    >{wallet?.address}</span
                                >
                                <button
                                    onclick={() =>
                                        copyTo(wallet?.address || "", "addr")}
                                    class="hover:text-white"
                                >
                                    {#if copiedField === "addr"}<Check
                                            class="w-4 h-4 text-green-400"
                                        />{:else}<Copy class="w-4 h-4" />{/if}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="space-y-6">
                        <div
                            class="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-6 h-full"
                        >
                            <h3 class="text-xl font-semibold mb-4 text-white">
                                Security
                            </h3>
                            <button
                                onclick={() =>
                                    (showPrivateKey = !showPrivateKey)}
                                class="text-blue-400 text-sm font-medium flex items-center gap-1 hover:text-blue-300 mb-2"
                            >
                                {#if showPrivateKey}<EyeOff class="w-4 h-4" /> Hide
                                    Private Key{:else}<Eye class="w-4 h-4" /> Reveal
                                    Private Key{/if}
                            </button>
                            <div
                                class="font-mono text-xs break-all bg-black p-3 rounded-lg border border-zinc-800 {showPrivateKey
                                    ? 'text-white'
                                    : 'text-zinc-700 blur-[4px] select-none'}"
                            >
                                {showPrivateKey
                                    ? wallet?.privateKey
                                    : "•".repeat(64)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</div>
