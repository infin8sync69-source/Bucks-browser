<script lang="ts">
    // Live status cards on the new tab: wallet, IPFS node and agent. Each opens its page; the
    // agent card also has the model picker. Values come from the real subsystems; a card says so
    // when there is nothing to show yet rather than showing a placeholder number.
    import { onMount } from "svelte";
    import { ChevronRight, SlidersHorizontal, Sparkles, Wallet, Globe, Bot } from "lucide-svelte";
    import { bucks, type SoulStatus } from "$lib/bridge";
    import { browserStore } from "$lib/stores";
    import { ipfsStore } from "$lib/ipfsStore";
    import { swarmStore } from "$lib/swarmStore";
    import { settingsStore } from "$lib/settingsStore";
    import { chatOpen, pushOverlay, popOverlay, requestAgentBar } from "$lib/uiState";
    import ModelPicker from "./ModelPicker.svelte";

    const WALLET_KEY = "bucks_wallet_v2";
    const PROVIDER_LABEL: Record<string, string> = { soul: "Soul Engine", ollama: "Ollama", remote: "Remote agent", offline: "Offline rules" };

    let address = $state<string | null>(null);
    let balance = $state<number | null>(null);
    let walletError = $state(false);
    let peers = $state<number | null>(null);
    let soul = $state<SoulStatus | null>(null);
    let pickerOpen = $state(false);
    let pickerUp = $state(false);
    let agentCard = $state<HTMLDivElement | null>(null);

    /** Open the picker below the card, or above it when the command bar leaves too little room. */
    function togglePicker() {
        const rect = agentCard?.getBoundingClientRect();
        pickerUp = !!rect && window.innerHeight - 230 - rect.bottom < 330 && rect.top - 100 > 200;
        pickerOpen = !pickerOpen;
    }

    /** Only the address is read from the stored wallet; its keys never leave the wallet page. */
    function readAddress(): string | null {
        try {
            const w = JSON.parse(localStorage.getItem(WALLET_KEY) || "null");
            return typeof w?.address === "string" ? w.address : null;
        } catch {
            return null;
        }
    }

    async function refreshWallet() {
        address = readAddress();
        if (!address) { balance = null; return; }
        try {
            const r = await bucks.wallet.rpc({ method: "GET", path: `/api/address/${address}/balance` });
            balance = typeof r?.balance === "number" ? r.balance : null;
            walletError = false;
        } catch {
            walletError = true;
        }
    }

    async function refreshPeers() {
        if ($ipfsStore.status?.state !== "ready") { peers = null; return; }
        peers = await ipfsStore.peers().then((p) => p.length).catch(() => null);
    }

    onMount(() => {
        void refreshWallet();
        void refreshPeers();
        bucks.agent.soulStatus().then((s) => (soul = s)).catch(() => {});
        const stopSoul = bucks.agent.onSoulStatus((s) => (soul = s));
        const timer = setInterval(() => { void refreshWallet(); void refreshPeers(); }, 15_000);
        const onStorage = (e: StorageEvent) => e.key === WALLET_KEY && void refreshWallet();
        window.addEventListener("storage", onStorage);
        return () => { clearInterval(timer); stopSoul(); window.removeEventListener("storage", onStorage); };
    });

    // Peer count as soon as the node becomes ready.
    let lastIpfsState = "";
    $effect(() => {
        const st = $ipfsStore.status?.state ?? "";
        if (st === lastIpfsState) return;
        lastIpfsState = st;
        void refreshPeers();
    });

    $effect(() => {
        if (!pickerOpen) return;
        pushOverlay();
        const close = () => (pickerOpen = false);
        window.addEventListener("click", close);
        return () => { window.removeEventListener("click", close); popOverlay(); };
    });

    const ipfsState = $derived($ipfsStore.status?.state ?? "idle");
    const provider = $derived($settingsStore?.agent.provider ?? $swarmStore.provider);
    const agentDetail = $derived.by(() => {
        if (provider === "soul" && soul && soul.state !== "ready") return soul.message;
        if ($swarmStore.isOnline === false) return provider === "offline" ? "Built-in rules, no model" : "Not reachable";
        if (provider === "soul") return "Ready · private on this computer";
        if (provider === "ollama") return "Ready · on this computer";
        if (provider === "remote") return "Ready · your server";
        return "Built-in rules, no model";
    });
    const agentDot = $derived(
        provider === "soul" && (soul?.state === "loading" || soul?.state === "starting" || soul?.state === "installing")
            ? "bg-amber-400 animate-pulse"
            : $swarmStore.isOnline ? "bg-emerald-400" : "bg-white/20",
    );
    const shortAddress = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
</script>

<div class="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
    <!-- Wallet -->
    <button onclick={() => browserStore.createOrFocusTab("bucks://wallet")} aria-label="Open wallet"
        class="group text-left rounded-2xl border border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] p-4 transition-colors">
        <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
            <span class="w-1.5 h-1.5 rounded-full {address && !walletError ? 'bg-emerald-400' : 'bg-white/20'}"></span>
            <Wallet size={12} /> Wallet
            <ChevronRight size={13} class="ml-auto opacity-0 group-hover:opacity-60 transition-opacity" />
        </div>
        {#if address}
            <div class="mt-2 text-[18px] text-white/90 tabular-nums">{balance !== null ? `${(balance / 1e8).toFixed(4)} BUCKS` : walletError ? "—" : "…"}</div>
            <div class="mt-0.5 text-[11px] text-white/35 font-mono">{walletError ? "Node not reachable" : shortAddress(address)}</div>
        {:else}
            <div class="mt-2 text-[15px] text-white/70">No wallet yet</div>
            <div class="mt-0.5 text-[11px] text-white/35">Create or restore one</div>
        {/if}
    </button>

    <!-- IPFS node -->
    <button onclick={() => browserStore.createOrFocusTab("bucks://ipfs")} aria-label="Open IPFS node"
        class="group text-left rounded-2xl border border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] p-4 transition-colors">
        <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
            <span class="w-1.5 h-1.5 rounded-full {ipfsState === 'ready' ? (peers ? 'bg-emerald-400' : 'bg-amber-400') : ipfsState === 'initializing' ? 'bg-amber-400 animate-pulse' : 'bg-white/20'}"></span>
            <Globe size={12} /> IPFS node
            <ChevronRight size={13} class="ml-auto opacity-0 group-hover:opacity-60 transition-opacity" />
        </div>
        {#if ipfsState === "ready"}
            <div class="mt-2 text-[18px] text-white/90 tabular-nums">{peers === null ? "…" : `${peers} peer${peers === 1 ? "" : "s"}`}</div>
            <div class="mt-0.5 text-[11px] text-white/35">{peers ? "Online" : "Looking for peers…"}</div>
        {:else if ipfsState === "initializing"}
            <div class="mt-2 text-[15px] text-white/70">Starting…</div>
            <div class="mt-0.5 text-[11px] text-white/35">{$ipfsStore.status?.message ?? ""}</div>
        {:else}
            <div class="mt-2 text-[15px] text-white/70">Offline</div>
            <div class="mt-0.5 text-[11px] text-white/35 truncate">{$ipfsStore.status?.message || "The node is not running"}</div>
        {/if}
    </button>

    <!-- Agent -->
    <div bind:this={agentCard} class="relative group rounded-2xl border border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.12] transition-colors {pickerOpen ? 'z-30' : ''}">
        <button onclick={() => chatOpen.set(true)} aria-label="Open agent chat" class="w-full text-left p-4">
            <div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/40">
                <span class="w-1.5 h-1.5 rounded-full {agentDot}"></span>
                <Bot size={12} /> Agent
            </div>
            <div class="mt-2 text-[15px] text-white/90 truncate pr-16">
                {PROVIDER_LABEL[provider] ?? provider}{#if $swarmStore.model}<span class="text-white/45 font-mono text-[12px]"> · {$swarmStore.model}</span>{/if}
            </div>
            <div class="mt-0.5 text-[11px] text-white/35 line-clamp-2">{agentDetail}</div>
        </button>
        <div class="absolute top-3 right-3 flex items-center gap-1">
            <button onclick={(e) => { e.stopPropagation(); requestAgentBar(); }} title="Start a task"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
                <Sparkles size={13} />
            </button>
            <button onclick={(e) => { e.stopPropagation(); togglePicker(); }} title="Choose model" aria-label="Choose model" aria-expanded={pickerOpen}
                class="w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors">
                <SlidersHorizontal size={13} />
            </button>
        </div>
        {#if pickerOpen}
            <ModelPicker up={pickerUp} onclose={() => (pickerOpen = false)} />
        {/if}
    </div>
</div>
