<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
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
        fromHex,
    } from "$lib/bucks-crypto";
    import { bucks } from "$lib/bridge";
    import { settingsStore } from "$lib/settingsStore";

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
    /** Pre-Electron override for the node URL; migrated into settings.wallet.nodeUrl once. */
    const LEGACY_NODE_URL_KEY = "bucks_node_url";
    /** 1 BUCKS = 1e8 base units (the unit the node, UTXOs and the signer work in). */
    const UNITS_PER_BUCKS = 1e8;

    // State (Svelte 5 Runes)
    let step = $state<FlowStep>("loading");
    let wallet = $state<WalletInfo | null>(null);
    const nodeUrl = $derived($settingsStore?.wallet.nodeUrl ?? "");
    let chainInfo = $state<any>(null);
    let nodeError = $state("");
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

    /** Call the configured Bucks node through the main process. Throws with the node's error message. */
    function rpc(method: "GET" | "POST", path: string, body?: unknown) {
        return bucks.wallet.rpc({ method, path, body });
    }

    /** Like rpc() but for background refreshes: failures are surfaced in `nodeError`, not thrown. */
    async function tryRpc(method: "GET" | "POST", path: string, body?: unknown) {
        try {
            const res = await rpc(method, path, body);
            nodeError = "";
            return res;
        } catch (e) {
            nodeError = e instanceof Error ? e.message : String(e);
            return null;
        }
    }

    async function fetchBalances() {
        if (!wallet) return;
        const res = await tryRpc(
            "GET",
            `/api/address/${wallet.address}/balance`,
        );
        if (res?.success) {
            wallet.balance = res.balance;
        }
    }

    async function fetchChainInfo() {
        const res = await tryRpc("GET", "/api/blockchain/info");
        if (res) chainInfo = res;
    }

    onMount(() => {
        void settingsStore.init();
        try {
            const legacyNode = localStorage.getItem(LEGACY_NODE_URL_KEY);
            if (legacyNode) {
                void settingsStore.patch({ wallet: { nodeUrl: legacyNode } }).catch(() => {});
                localStorage.removeItem(LEGACY_NODE_URL_KEY);
            }
        } catch {}

        // Check for payment prefill from EphemeralWidget
        try {
            const prefill = sessionStorage.getItem("bucks_pay_prefill");
            if (prefill) {
                const p = JSON.parse(prefill);
                sendTo = p.to ?? "";
                sendAmount = p.amount ?? "";
                sessionStorage.removeItem("bucks_pay_prefill");
            }
        } catch {}

        const savedWallet = localStorage.getItem(STORAGE_KEY);
        if (savedWallet) {
            try {
                const w = JSON.parse(savedWallet);
                wallet = w;
                // If we have payment prefill, open send tab directly
                const hasPrefill = sendTo || sendAmount;
                step = "dashboard";
                if (hasPrefill) dashTab = "send";
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

    // Send Flow
    async function handleSend() {
        if (!wallet || !sendTo.trim() || !sendAmount) return;
        sendPhase = "sending";
        try {
            const units = Math.round(parseFloat(sendAmount) * UNITS_PER_BUCKS);
            if (!Number.isSafeInteger(units) || units <= 0) throw new Error("Enter an amount greater than zero");

            const utxoRes = await rpc("GET", `/api/address/${wallet.address}/utxos`);
            if (!utxoRes?.success) throw new Error(utxoRes?.error || "Could not fetch UTXOs");

            // Sign locally: the private key never leaves this page.
            const { rawHex, txid } = await buildAndSignTransaction(
                utxoRes.utxos ?? [],
                sendTo.trim(),
                units,
                fromHex(wallet.privateKey),
                fromHex(wallet.publicKey),
                wallet.address,
            );

            const result = await rpc("POST", "/api/transactions/broadcast", { rawTx: rawHex });
            if (!result?.success) throw new Error(result?.error || "Broadcast rejected by the node");
            sendResult = { success: true, hash: result.txid ?? txid };
            sendPhase = "receipt";
            await fetchBalances();
        } catch (e: any) {
            sendResult = { success: false, error: e?.message ?? "Transaction failed" };
            sendPhase = "receipt";
        }
    }

    function resetSend() {
        sendTo = ""; sendAmount = ""; sendPhase = "form"; sendResult = null;
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
    class="relative h-full w-full overflow-y-auto no-scrollbar bg-surface-raised"
>
    {#if step === "loading"}
        <div
            class="min-h-full flex flex-col justify-center items-center font-sans"
        >
            <Loader2 class="w-8 h-8 text-accent-fg animate-spin mb-4" />
            <div class="text-fg-faint text-md">
                Initializing Secure Environment...
            </div>
        </div>
    {:else if step === "welcome"}
        <div
            class="min-h-full flex flex-col justify-center items-center font-sans p-8 relative"
        >
            <div
                class="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-accent/10 blur-4xl rounded-full pointer-events-none"
            ></div>

            <div
                class="z-raised w-full max-w-md"
                in:scale={{ duration: motion.moderate, start: 0.95 }}
            >
                <div class="mb-12 text-center">
                    <div
                        class="w-20 h-20 bg-gradient-to-tr from-accent-emphasis to-cat-cyan rounded-3xl mx-auto mb-6 flex items-center justify-center shadow-2xl shadow-accent/20 rotate-12"
                    >
                        <Wallet class="w-10 h-10 text-on-emphasis -rotate-12" />
                    </div>
                    <h1
                        class="text-4xl font-semibold mb-3 tracking-tighter text-fg"
                    >
                        Welcome to Bucks
                    </h1>
                    <p class="text-fg-subtle text-lg">
                        The secure, client-side gateway to the distributed
                        economy.
                    </p>
                </div>

                <div class="space-y-4">
                    <button
                        onclick={handleCreate}
                        class="group relative w-full flex items-center p-5 bg-surface-3 border border-line rounded-2xl hover:bg-surface-4 transition-all overflow-hidden text-left"
                    >
                        <div
                            class="w-12 h-12 bg-accent/10 rounded-xl flex items-center justify-center mr-4 text-accent-fg"
                        >
                            <Plus class="w-6 h-6" />
                        </div>
                        <div class="flex-1">
                            <div class="font-medium text-lg text-fg">
                                Create New Wallet
                            </div>
                            <div class="text-fg-faint text-md mt-0.5">
                                Generate a new 10-word phrase
                            </div>
                        </div>
                        <ArrowRight
                            class="w-5 h-5 text-fg-faint group-hover:text-accent-fg transition-colors"
                        />
                    </button>

                    <button
                        onclick={() => (step = "import")}
                        class="group relative w-full flex items-center p-5 bg-surface-3 border border-line rounded-2xl hover:bg-surface-4 transition-all text-left"
                    >
                        <div
                            class="w-12 h-12 bg-cat-purple/10 rounded-xl flex items-center justify-center mr-4 text-cat-purple-fg"
                        >
                            <Import class="w-6 h-6" />
                        </div>
                        <div class="flex-1">
                            <div class="font-medium text-lg text-fg">
                                Import Existing Wallet
                            </div>
                            <div class="text-fg-faint text-md mt-0.5">
                                Restore using recovery phrase
                            </div>
                        </div>
                        <ArrowRight
                            class="w-5 h-5 text-fg-faint group-hover:text-cat-purple-fg transition-colors"
                        />
                    </button>
                </div>
            </div>
        </div>
    {:else if step === "creating" || step === "import-verifying"}
        <div class="min-h-full flex flex-col justify-center items-center">
            <div
                class="mb-8 w-16 h-16 rounded-full border-4 border-line border-t-accent animate-spin"
            ></div>
            <h2 class="text-2xl font-medium mb-3 text-fg">
                {step === "import-verifying"
                    ? "Restoring Wallet"
                    : "Generating Keys"}
            </h2>
            <p class="text-fg-faint flex items-center gap-2">
                <Shield class="w-4 h-4" /> Client-side secp256k1 ECDSA
            </p>
        </div>
    {:else if step === "import"}
        <div class="min-h-full flex flex-col justify-center items-center p-8">
            <div class="w-full max-w-lg" in:fade={{ duration: motion.moderate }}>
                <button
                    onclick={() => (step = "welcome")}
                    class="flex items-center text-fg-faint hover:text-fg mb-8 transition-colors"
                >
                    <ArrowLeft class="w-4 h-4 mr-2" /> Back
                </button>
                <h2 class="text-3xl font-semibold mb-3 text-fg">
                    Import from Mnemonic
                </h2>
                <p class="text-fg-subtle mb-8">
                    Type or paste your 10-word recovery phrase to restore your
                    wallet locally.
                </p>
                <textarea
                    bind:value={importPhrase}
                    oninput={() => (importError = "")}
                    placeholder="word1 word2 word3..."
                    class="w-full h-32 bg-surface-3 border border-line rounded-2xl p-6 text-fg text-lg resize-none mb-6 outline-none focus:border-line-emphasis"
                ></textarea>

                {#if importError}
                    <div
                        class="flex items-center gap-2 text-danger-fg bg-danger/10 p-4 rounded-xl mb-6 border border-danger/20"
                    >
                        <AlertTriangle class="w-5 h-5" />
                        {importError}
                    </div>
                {/if}
                <button
                    onclick={handleImport}
                    disabled={!importPhrase.trim()}
                    class="w-full bg-fg text-fg-inverse font-semibold py-4 rounded-xl hover:bg-fg/85 transition-colors disabled:opacity-50"
                >
                    Restore Wallet
                </button>
            </div>
        </div>
    {:else if step === "mnemonic-display"}
        <div class="min-h-full flex flex-col items-center py-20 p-8">
            <div class="w-full max-w-2xl" in:fade={{ duration: motion.moderate }}>
                <h2 class="text-3xl font-semibold mb-3 text-fg">
                    Secure your Recovery Phrase
                </h2>
                <p class="text-fg-subtle mb-8">
                    Write down these 10 words in order. This is the only way to
                    recover your wallet.
                </p>

                <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
                    {#each mnemonic.split(" ") as word, i}
                        <div
                            class="relative bg-surface-4 border border-line-strong text-fg-muted p-3 rounded-lg text-center text-md font-medium"
                        >
                            <span
                                class="absolute -top-2 -left-2 w-5 h-5 bg-surface-5 text-3xs rounded-full flex items-center justify-center text-fg-subtle z-raised"
                                >{i + 1}</span
                            >
                            {word}
                        </div>
                    {/each}
                </div>

                <div class="flex gap-4">
                    <button
                        onclick={() => copyTo(mnemonic, "mnemonic")}
                        class="p-4 bg-surface-3 border border-line rounded-xl text-fg hover:bg-surface-4 transition-all"
                    >
                        {#if copiedField === "mnemonic"}<Check
                                class="w-5 h-5 text-success-fg"
                            />{:else}<Copy class="w-5 h-5" />{/if}
                    </button>
                    <button
                        onclick={() => (step = "mnemonic-verify")}
                        class="flex-1 bg-fg text-fg-inverse font-semibold py-4 rounded-xl hover:bg-fg/85 transition-colors"
                    >
                        I've Saved It
                    </button>
                </div>
            </div>
        </div>
    {:else if step === "mnemonic-verify"}
        <div class="min-h-full flex flex-col items-center py-20 p-8">
            <div class="w-full max-w-lg" in:fade={{ duration: motion.moderate }}>
                <h2 class="text-3xl font-semibold mb-3 text-fg">Verify Your Phrase</h2>
                <p class="text-fg-subtle mb-8">
                    Confirm 3 words from your recovery phrase to prove you saved it.
                </p>
                <div class="space-y-4 mb-6">
                    {#each verifyIndices as wordIdx, i}
                        <div>
                            <label for={`verify-word-${i}`} class="text-xs text-fg-faint mb-1 block">Word #{wordIdx + 1}</label>
                            <input
                                id={`verify-word-${i}`}
                                type="text"
                                bind:value={verifyAnswers[i]}
                                oninput={() => verifyError = ""}
                                placeholder={`Enter word #${wordIdx + 1}`}
                                class="w-full bg-surface-3 border border-line rounded-xl px-4 py-3 text-fg text-md font-mono outline-none focus:border-line-emphasis"
                            />
                        </div>
                    {/each}
                </div>
                {#if verifyError}
                    <div class="flex items-center gap-2 text-danger-fg bg-danger/10 p-4 rounded-xl mb-4 border border-danger/20">
                        <AlertTriangle class="w-5 h-5" />
                        {verifyError}
                    </div>
                {/if}
                <div class="flex gap-4">
                    <button onclick={() => (step = "mnemonic-display")}
                        class="px-6 py-4 bg-surface-3 border border-line rounded-xl text-fg-subtle hover:text-fg text-md transition-colors">
                        Back
                    </button>
                    <button onclick={handleVerifyComplete}
                        disabled={verifyAnswers.some(a => !a)}
                        class="flex-1 bg-fg text-fg-inverse font-semibold py-4 rounded-xl hover:bg-fg/85 transition-colors disabled:opacity-50">
                        Confirm &amp; Continue
                    </button>
                </div>
            </div>
        </div>
    {:else if step === "dashboard" && wallet}
        <div class="min-h-full p-8 pb-32">
            <div class="max-w-5xl mx-auto">
                <!-- Tab strip -->
                <div class="flex gap-1 mb-6 bg-surface-3/60 p-1 rounded-xl w-fit border border-line">
                    {#each [["overview","Overview"],["send","Send"]] as [tab, label]}
                        <button
                            onclick={() => dashTab = tab as DashboardTab}
                            class="px-5 py-2 rounded-lg text-md font-medium transition-colors {dashTab === tab ? 'bg-fg text-fg-inverse' : 'text-fg-subtle hover:text-fg'}"
                        >{label}</button>
                    {/each}
                </div>

                {#if dashTab === "send"}
                    <div class="max-w-lg" in:fade={{ duration: motion.base }}>
                        <h2 class="text-2xl font-semibold text-fg mb-6">Send BUCKS</h2>
                        {#if sendPhase === "form" || sendPhase === "review"}
                            <div class="space-y-4">
                                <div>
                                    <label for="send-to" class="text-xs text-fg-faint mb-1 block">Recipient Address</label>
                                    <input id="send-to" bind:value={sendTo} placeholder="0x..."
                                        class="w-full bg-surface-3 border border-line rounded-xl px-4 py-3 text-fg text-md font-mono outline-none focus:border-line-emphasis" />
                                </div>
                                <div>
                                    <label for="send-amount" class="text-xs text-fg-faint mb-1 block">Amount (BUCKS)</label>
                                    <input id="send-amount" bind:value={sendAmount} type="number" min="0" step="0.0001" placeholder="0.00"
                                        class="w-full bg-surface-3 border border-line rounded-xl px-4 py-3 text-fg text-md outline-none focus:border-line-emphasis" />
                                </div>
                                <p class="text-xs text-fg-faint">Available: {(wallet.balance / 1e8).toFixed(4)} BUCKS</p>
                                <button onclick={handleSend} disabled={!sendTo.trim() || !sendAmount}
                                    class="w-full bg-accent-emphasis hover:bg-accent-emphasis-hover text-on-emphasis font-semibold py-3.5 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                                    <Send class="w-4 h-4" /> Send Transaction
                                </button>
                            </div>
                        {:else if sendPhase === "sending"}
                            <div class="flex flex-col items-center py-12 gap-4">
                                <Loader2 class="w-8 h-8 text-accent-fg animate-spin" />
                                <p class="text-fg-subtle text-md">Broadcasting transaction...</p>
                            </div>
                        {:else if sendPhase === "receipt"}
                            <div class="flex flex-col items-center py-10 gap-4 text-center" in:scale={{ duration: motion.moderate }}>
                                {#if sendResult?.success}
                                    <CheckCircle class="w-14 h-14 text-success-fg" />
                                    <p class="text-xl font-semibold text-fg">Sent!</p>
                                    <p class="text-xs text-fg-faint font-mono break-all max-w-xs">{sendResult.hash}</p>
                                {:else}
                                    <AlertTriangle class="w-14 h-14 text-danger-fg" />
                                    <p class="text-xl font-semibold text-fg">Failed</p>
                                    <p class="text-md text-danger-fg">{sendResult?.error}</p>
                                {/if}
                                <button onclick={resetSend} class="mt-2 px-6 py-2.5 bg-surface-4 hover:bg-surface-5 text-fg rounded-xl text-md transition-colors">
                                    New Transfer
                                </button>
                            </div>
                        {/if}
                    </div>
                {:else}
                <header class="flex items-center justify-between mb-8">
                    <div class="flex items-center gap-3">
                        <div
                            class="w-12 h-12 bg-accent-emphasis rounded-2xl flex items-center justify-center shadow-lg shadow-accent/20"
                        >
                            <Wallet class="w-6 h-6 text-on-emphasis" />
                        </div>
                        <div>
                            <h1 class="text-xl font-bold text-fg">
                                Client Wallet
                            </h1>
                            <div class="text-md text-fg-faint">
                                Node: <span class="font-mono">{nodeUrl || "—"}</span>
                            </div>
                            {#if nodeError}
                                <div class="text-xs text-danger-fg mt-0.5">Node unreachable: {nodeError}</div>
                            {/if}
                        </div>
                    </div>
                    <button
                        onclick={handleReset}
                        class="flex items-center gap-2 px-4 py-2 rounded-xl text-md font-medium transition-colors bg-surface-3 text-fg-subtle hover:text-fg border border-line {confirmReset
                            ? '!bg-danger-emphasis !text-on-emphasis'
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
                            class="relative bg-gradient-to-br from-accent-emphasis to-cat-indigo-deep rounded-3xl p-8 overflow-hidden shadow-2xl shadow-accent/20"
                            in:fly={{ y: 20 }}
                        >
                            <div class="mb-8">
                                <div class="text-accent-fg-strong font-medium mb-1">
                                    Total Balance
                                </div>
                                <div class="flex items-baseline gap-2">
                                    <span
                                        class="text-5xl font-bold tracking-tight text-fg"
                                        >{formatBalance(
                                            wallet?.balance || 0,
                                        )}</span
                                    >
                                    <span
                                        class="text-xl font-medium text-accent-fg-strong"
                                        >BUCKS</span
                                    >
                                </div>
                            </div>
                            <!-- Address Pill -->
                            <div
                                class="inline-flex items-center gap-2 bg-scrim/20 rounded-full px-4 py-1.5 text-md font-mono text-fg-muted"
                            >
                                <span class="truncate max-w-[200px]"
                                    >{wallet?.address}</span
                                >
                                <button
                                    onclick={() =>
                                        copyTo(wallet?.address || "", "addr")}
                                    class="hover:text-fg"
                                >
                                    {#if copiedField === "addr"}<Check
                                            class="w-4 h-4 text-success-fg"
                                        />{:else}<Copy class="w-4 h-4" />{/if}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div class="space-y-6">
                        <div
                            class="bg-surface-3/50 border border-line rounded-3xl p-6 h-full"
                        >
                            <h3 class="text-xl font-semibold mb-4 text-fg">
                                Security
                            </h3>
                            <p class="flex items-start gap-2 text-xs text-warning-fg-strong/80 bg-warning/10 border border-warning/20 rounded-xl p-3 mb-4">
                                <AlertTriangle class="w-4 h-4 shrink-0 mt-px" />
                                Keys are stored unencrypted in this profile's local storage.
                            </p>
                            <button
                                onclick={() =>
                                    (showPrivateKey = !showPrivateKey)}
                                class="text-accent-fg text-md font-medium flex items-center gap-1 hover:text-accent-fg-strong mb-2"
                            >
                                {#if showPrivateKey}<EyeOff class="w-4 h-4" /> Hide
                                    Private Key{:else}<Eye class="w-4 h-4" /> Reveal
                                    Private Key{/if}
                            </button>
                            <div
                                class="font-mono text-xs break-all bg-scrim p-3 rounded-lg border border-line {showPrivateKey
                                    ? 'text-fg'
                                    : 'text-fg-disabled blur-xs select-none'}"
                            >
                                {showPrivateKey
                                    ? wallet?.privateKey
                                    : "•".repeat(64)}
                            </div>
                        </div>
                    </div>
                </div><!-- grid -->
        {/if}<!-- end dashTab split -->
            </div><!-- max-w-5xl -->
        </div><!-- min-h-full -->
    {/if}<!-- step dashboard -->
</div>
