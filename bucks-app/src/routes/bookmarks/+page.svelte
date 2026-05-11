<script lang="ts">
    import { browserStore, activeTab } from "$lib/stores";
    import { fade } from "svelte/transition";

    let search = $state("");
    let editingId = $state<string | null>(null);
    let editTitle = $state("");

    const filtered = $derived(
        search.trim()
            ? $browserStore.bookmarks.filter(b =>
                b.title.toLowerCase().includes(search.toLowerCase()) ||
                b.url.toLowerCase().includes(search.toLowerCase()))
            : $browserStore.bookmarks
    );

    function open(url: string) { browserStore.navigateActiveTab(url); }
    function remove(id: string) { browserStore.removeBookmark(id); }

    function addCurrent() {
        const tab = $activeTab;
        if (!tab || tab.url === "bucks://newtab") return;
        browserStore.addBookmark(tab.url, tab.title);
    }

    function startEdit(b: { id: string; title: string }) {
        editingId = b.id;
        editTitle = b.title;
    }

    function saveEdit(id: string) {
        if (editTitle.trim()) browserStore.updateBookmark(id, { title: editTitle.trim() });
        editingId = null;
    }

    function formatDate(ts: number) {
        return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
</script>

<div class="min-h-screen bg-[#07070a] text-white px-8 py-10 max-w-2xl mx-auto space-y-6" in:fade={{ duration: 300 }}>

    <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">🔖</div>
            <div>
                <h1 class="text-lg font-semibold tracking-tight">Bookmarks</h1>
                <p class="text-[11px] text-white/30">{$browserStore.bookmarks.length} saved</p>
            </div>
        </div>
        <button onclick={addCurrent}
            class="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/25 text-blue-300 text-[12px] font-medium transition-all">
            + Bookmark current tab
        </button>
    </div>

    <!-- Search -->
    <div class="relative">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input bind:value={search} placeholder="Search bookmarks…"
            class="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-9 pr-4 py-2.5 text-[13px] text-white placeholder-white/25 focus:outline-none focus:border-blue-500/40 transition-colors" />
    </div>

    <!-- List -->
    {#if filtered.length === 0}
        <div class="text-center py-16 text-white/25 text-sm">
            {search ? "No bookmarks match your search" : "No bookmarks yet — visit a page and click + Bookmark"}
        </div>
    {:else}
        <div class="space-y-1.5">
            {#each filtered as b (b.id)}
                <div class="group flex items-center gap-3 p-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] hover:bg-white/[0.05] transition-all">
                    <div class="w-8 h-8 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center text-sm shrink-0">
                        {b.url.startsWith("ipfs") ? "🌐" : b.url.startsWith("https") ? "🔒" : "🌍"}
                    </div>
                    <div class="flex-1 min-w-0">
                        {#if editingId === b.id}
                            <input bind:value={editTitle}
                                onblur={() => saveEdit(b.id)}
                                onkeydown={(e) => e.key === "Enter" && saveEdit(b.id)}
                                class="w-full bg-white/[0.06] border border-white/[0.15] rounded-lg px-2 py-0.5 text-[13px] text-white outline-none" />
                        {:else}
                            <button onclick={() => open(b.url)}
                                class="text-[13px] font-medium text-white/75 hover:text-white transition-colors truncate block w-full text-left">
                                {b.title}
                            </button>
                        {/if}
                        <p class="text-[10px] text-white/25 truncate mt-0.5">{b.url}</p>
                    </div>
                    <p class="text-[10px] text-white/20 shrink-0">{formatDate(b.addedAt)}</p>
                    <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick={() => startEdit(b)} class="p-1.5 rounded-lg hover:bg-white/10 text-white/30 hover:text-white/70 transition-colors text-[11px]">✎</button>
                        <button onclick={() => remove(b.id)} class="p-1.5 rounded-lg hover:bg-red-500/15 text-white/25 hover:text-red-400 transition-colors">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>
