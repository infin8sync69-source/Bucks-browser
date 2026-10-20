<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
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

<div class="min-h-screen bg-canvas text-fg px-8 py-10 max-w-2xl mx-auto space-y-6" in:fade={{ duration: motion.moderate }}>

    <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-2xl bg-surface-2 border border-line-strong flex items-center justify-center">🔖</div>
            <div>
                <h1 class="text-lg font-semibold tracking-tight">Bookmarks</h1>
                <p class="text-2xs text-fg-faint">{$browserStore.bookmarks.length} saved</p>
            </div>
        </div>
        <button onclick={addCurrent}
            class="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent/15 hover:bg-accent/25 border border-accent/25 text-accent-fg-strong text-xs font-medium transition-all">
            + Bookmark current tab
        </button>
    </div>

    <!-- Search -->
    <div class="relative">
        <svg class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input bind:value={search} placeholder="Search bookmarks…"
            class="w-full bg-surface-2 border border-line rounded-xl pl-9 pr-4 py-2.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent/40 transition-colors" />
    </div>

    <!-- List -->
    {#if filtered.length === 0}
        <div class="text-center py-16 text-fg-faint text-md">
            {search ? "No bookmarks match your search" : "No bookmarks yet — visit a page and click + Bookmark"}
        </div>
    {:else}
        <div class="space-y-1.5">
            {#each filtered as b (b.id)}
                <div class="group flex items-center gap-3 p-3 rounded-2xl border border-line-subtle bg-surface-1 hover:bg-surface-2 transition-all">
                    <div class="w-8 h-8 rounded-xl bg-surface-2 border border-line flex items-center justify-center text-md shrink-0">
                        {b.url.startsWith("ipfs") ? "🌐" : b.url.startsWith("https") ? "🔒" : "🌍"}
                    </div>
                    <div class="flex-1 min-w-0">
                        {#if editingId === b.id}
                            <input bind:value={editTitle}
                                onblur={() => saveEdit(b.id)}
                                onkeydown={(e) => e.key === "Enter" && saveEdit(b.id)}
                                class="w-full bg-surface-3 border border-line-emphasis rounded-lg px-2 py-0.5 text-sm text-fg outline-none" />
                        {:else}
                            <button onclick={() => open(b.url)}
                                class="text-sm font-medium text-fg-muted hover:text-fg transition-colors truncate block w-full text-left">
                                {b.title}
                            </button>
                        {/if}
                        <p class="text-3xs text-fg-faint truncate mt-0.5">{b.url}</p>
                    </div>
                    <p class="text-3xs text-fg-disabled shrink-0">{formatDate(b.addedAt)}</p>
                    <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onclick={() => startEdit(b)} aria-label="Rename bookmark" title="Rename" class="p-1.5 rounded-lg hover:bg-surface-4 text-fg-faint hover:text-fg-muted transition-colors text-2xs">✎</button>
                        <button onclick={() => remove(b.id)} aria-label="Remove bookmark" title="Remove" class="p-1.5 rounded-lg hover:bg-danger/15 text-fg-faint hover:text-danger-fg transition-colors">
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
