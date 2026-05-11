<script lang="ts">
    import { browserStore } from "$lib/stores";
    import { fade } from "svelte/transition";

    let search = $state("");

    const grouped = $derived(() => {
        const entries = search.trim()
            ? $browserStore.history.filter(h =>
                h.title.toLowerCase().includes(search.toLowerCase()) ||
                h.url.toLowerCase().includes(search.toLowerCase()))
            : $browserStore.history;

        const groups: Record<string, typeof entries> = {};
        const today     = new Date(); today.setHours(0,0,0,0);
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

        for (const h of entries) {
            const d = new Date(h.visitedAt); d.setHours(0,0,0,0);
            let label: string;
            if (d.getTime() === today.getTime())     label = "Today";
            else if (d.getTime() === yesterday.getTime()) label = "Yesterday";
            else label = d.toLocaleDateString("en-US", { weekday:"long", month:"short", day:"numeric" });
            (groups[label] = groups[label] ?? []).push(h);
        }
        return Object.entries(groups);
    });

    function open(url: string)   { browserStore.navigateActiveTab(url); }
    function remove(url: string) { browserStore.removeHistoryEntry(url); }

    function formatTime(ts: number) {
        return new Date(ts).toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit" });
    }
</script>

<div class="min-h-screen bg-[#07070a] text-white px-8 py-10 max-w-2xl mx-auto space-y-6" in:fade={{ duration: 300 }}>

    <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">🕐</div>
            <div>
                <h1 class="text-lg font-semibold tracking-tight">History</h1>
                <p class="text-[11px] text-white/30">{$browserStore.history.length} entries</p>
            </div>
        </div>
        {#if $browserStore.history.length > 0}
            <button onclick={() => browserStore.clearHistory()}
                class="px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-[12px] font-medium transition-all">
                Clear All
            </button>
        {/if}
    </div>

    <!-- Search -->
    <div class="relative">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input bind:value={search} placeholder="Search history…"
            class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-9 pr-4 py-2.5 text-[13px] text-white placeholder-white/25 focus:outline-none focus:border-blue-500/40 transition-colors" />
    </div>

    <!-- Grouped list -->
    {#if $browserStore.history.length === 0}
        <div class="text-center py-16 text-white/25 text-sm">No history yet</div>
    {:else}
        <div class="space-y-6">
            {#each grouped() as [label, entries]}
                <div class="space-y-1">
                    <p class="text-[9px] uppercase tracking-[0.3em] text-white/25 font-bold px-1 mb-2">{label}</p>
                    {#each entries as h (h.url + h.visitedAt)}
                        <div class="group flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.04] transition-all">
                            <div class="w-7 h-7 rounded-lg bg-white/[0.03] border border-white/[0.05] flex items-center justify-center text-xs shrink-0">
                                {h.url.startsWith("ipfs") ? "🌐" : h.url.startsWith("bucks") ? "◈" : "🔒"}
                            </div>
                            <div class="flex-1 min-w-0">
                                <button onclick={() => open(h.url)}
                                    class="text-[13px] text-white/65 hover:text-white transition-colors truncate block w-full text-left">
                                    {h.title || h.url}
                                </button>
                                <p class="text-[10px] text-white/25 truncate">{h.url}</p>
                            </div>
                            <span class="text-[10px] text-white/20 shrink-0">{formatTime(h.visitedAt)}</span>
                            <button onclick={() => remove(h.url)}
                                class="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-500/15 text-white/25 hover:text-red-400 transition-all">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    {/each}
                </div>
            {/each}
        </div>
    {/if}
</div>
