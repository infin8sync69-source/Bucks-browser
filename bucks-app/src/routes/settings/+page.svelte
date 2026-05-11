<script lang="ts">
    import { browserStore } from "$lib/stores";
    import { fade } from "svelte/transition";

    let searchEngine = $state(localStorage.getItem("bucks_search_engine") ?? "duckduckgo");
    let ipfsGateway  = $state(localStorage.getItem("bucks_ipfs_gateway")  ?? "local");
    let saved = $state(false);

    const engines = [
        { id: "duckduckgo", label: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
        { id: "google",     label: "Google",     url: "https://google.com/search?q=" },
        { id: "brave",      label: "Brave",      url: "https://search.brave.com/search?q=" },
        { id: "bing",       label: "Bing",       url: "https://bing.com/search?q=" },
    ];

    const gateways = [
        { id: "local",   label: "Local node (fastest)",      url: "http://127.0.0.1:50592/ipfs/" },
        { id: "ipfs.io", label: "ipfs.io (public)",          url: "https://ipfs.io/ipfs/" },
        { id: "cf",      label: "Cloudflare (public)",       url: "https://cloudflare-ipfs.com/ipfs/" },
    ];

    function save() {
        localStorage.setItem("bucks_search_engine", searchEngine);
        localStorage.setItem("bucks_ipfs_gateway",  ipfsGateway);
        saved = true;
        setTimeout(() => saved = false, 2000);
    }

    function clearData() {
        if (!confirm("Clear all tabs, bookmarks and history? This cannot be undone.")) return;
        localStorage.removeItem("bucks_browser_v2");
        window.location.reload();
    }
</script>

<div class="min-h-screen bg-[#07070a] text-white px-8 py-10 max-w-2xl mx-auto space-y-10" in:fade={{ duration: 300 }}>

    <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-base">⚙️</div>
        <h1 class="text-lg font-semibold tracking-tight">Settings</h1>
    </div>

    <!-- Search engine -->
    <section class="space-y-3">
        <p class="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold">Default Search Engine</p>
        <div class="space-y-1.5">
            {#each engines as e}
                <label class="flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all
                              {searchEngine === e.id ? 'border-blue-500/40 bg-blue-500/8' : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'}">
                    <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0
                                {searchEngine === e.id ? 'border-blue-400' : 'border-white/20'}">
                        {#if searchEngine === e.id}
                            <div class="w-2 h-2 rounded-full bg-blue-400"></div>
                        {/if}
                    </div>
                    <input type="radio" bind:group={searchEngine} value={e.id} class="hidden" />
                    <span class="text-[13px] text-white/70">{e.label}</span>
                    <span class="ml-auto text-[10px] text-white/25 font-mono truncate max-w-[180px]">{e.url}…</span>
                </label>
            {/each}
        </div>
    </section>

    <!-- IPFS gateway -->
    <section class="space-y-3">
        <p class="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold">IPFS Gateway</p>
        <div class="space-y-1.5">
            {#each gateways as g}
                <label class="flex items-center gap-3 p-3 rounded-2xl border cursor-pointer transition-all
                              {ipfsGateway === g.id ? 'border-emerald-500/40 bg-emerald-500/8' : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'}">
                    <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0
                                {ipfsGateway === g.id ? 'border-emerald-400' : 'border-white/20'}">
                        {#if ipfsGateway === g.id}
                            <div class="w-2 h-2 rounded-full bg-emerald-400"></div>
                        {/if}
                    </div>
                    <input type="radio" bind:group={ipfsGateway} value={g.id} class="hidden" />
                    <span class="text-[13px] text-white/70">{g.label}</span>
                </label>
            {/each}
        </div>
    </section>

    <!-- Save button -->
    <button onclick={save}
        class="px-6 py-2.5 rounded-2xl bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-blue-300 text-sm font-medium transition-all active:scale-95">
        {saved ? "✓ Saved" : "Save Settings"}
    </button>

    <!-- Danger zone -->
    <section class="space-y-3 pt-4 border-t border-white/[0.06]">
        <p class="text-[10px] uppercase tracking-[0.3em] text-red-400/50 font-bold">Danger Zone</p>
        <div class="rounded-2xl border border-red-500/15 bg-red-500/5 p-4 flex items-center justify-between">
            <div>
                <p class="text-[13px] text-white/60 font-medium">Clear all data</p>
                <p class="text-[11px] text-white/30 mt-0.5">Removes tabs, bookmarks and history</p>
            </div>
            <button onclick={clearData}
                class="px-4 py-2 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/25 text-red-400 text-[12px] font-medium transition-all">
                Clear Data
            </button>
        </div>
    </section>
</div>
