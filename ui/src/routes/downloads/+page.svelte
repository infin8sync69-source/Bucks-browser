<script lang="ts">
    import { onMount } from "svelte";
    import { fade } from "svelte/transition";
    import { Download, FolderOpen, File as FileIcon, X, Trash2, ExternalLink } from "lucide-svelte";
    import { bucks, type DownloadItem } from "$lib/bridge";
    import { formatBytes, errorMessage } from "$lib/format";

    let items = $state<DownloadItem[]>([]);
    let loaded = $state(false);
    let error = $state("");

    // Newest first
    const sorted = $derived([...items].sort((a, b) => b.startedAt - a.startedAt));
    const hasFinished = $derived(items.some((d) => d.state !== "progressing"));

    function upsert(item: DownloadItem) {
        const i = items.findIndex((d) => d.id === item.id);
        if (i === -1) items = [...items, item];
        else items = items.map((d) => (d.id === item.id ? item : d));
    }

    onMount(() => {
        // Subscribe first so no event between list() and the subscription is lost.
        const off = bucks.downloads.onEvent(upsert);
        bucks.downloads
            .list()
            .then((list) => {
                // Events that arrived while the list was in flight are newer than the snapshot.
                const live = new Map(items.map((d) => [d.id, d]));
                items = list.map((d) => live.get(d.id) ?? d).concat(items.filter((d) => !list.some((l) => l.id === d.id)));
            })
            .catch((e) => (error = errorMessage(e)))
            .finally(() => (loaded = true));
        return off;
    });

    async function run(action: () => Promise<void>) {
        error = "";
        try {
            await action();
        } catch (e) {
            error = errorMessage(e);
        }
    }

    function percent(d: DownloadItem): number {
        if (d.state === "completed") return 100;
        if (!d.totalBytes) return 0;
        return Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100));
    }

    function stateLabel(d: DownloadItem): string {
        switch (d.state) {
            case "progressing":
                return d.totalBytes
                    ? `${formatBytes(d.receivedBytes)} of ${formatBytes(d.totalBytes)}`
                    : `${formatBytes(d.receivedBytes)} downloaded`;
            case "completed":
                return formatBytes(d.totalBytes || d.receivedBytes);
            case "cancelled":
                return "Cancelled";
            default:
                return "Interrupted";
        }
    }

    function host(url: string): string {
        try {
            return new URL(url).host || url;
        } catch {
            return url;
        }
    }

    async function clearAll() {
        await run(() => bucks.downloads.clear());
        items = items.filter((d) => d.state === "progressing");
    }
</script>

<div class="min-h-full bg-[#07070a] text-white px-8 py-10 max-w-2xl mx-auto space-y-6" in:fade={{ duration: 300 }}>
    <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                <Download size={16} class="text-blue-400" />
            </div>
            <div>
                <h1 class="text-lg font-semibold tracking-tight">Downloads</h1>
                <p class="text-[11px] text-white/30">{items.length} item{items.length === 1 ? "" : "s"}</p>
            </div>
        </div>
        {#if hasFinished}
            <button
                onclick={clearAll}
                class="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-[12px] font-medium transition-all"
            >
                <Trash2 size={12} /> Clear list
            </button>
        {/if}
    </div>

    {#if error}
        <p class="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">{error}</p>
    {/if}

    {#if !loaded}
        <p class="text-[13px] text-white/30 py-8 text-center">Loading…</p>
    {:else if sorted.length === 0}
        <div class="text-center py-16 rounded-2xl border border-white/5 bg-white/[0.02]">
            <Download size={28} class="mx-auto text-white/15 mb-3" />
            <p class="text-[13px] text-white/40">No downloads yet</p>
            <p class="text-[11px] text-white/20 mt-1">Files you download from web pages appear here.</p>
        </div>
    {:else}
        <div class="space-y-2">
            {#each sorted as d (d.id)}
                <div class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 space-y-3">
                    <div class="flex items-start gap-3">
                        <div class="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center shrink-0">
                            <FileIcon size={16} class="text-white/40" />
                        </div>
                        <div class="min-w-0 flex-1">
                            <p class="text-[13px] text-white/80 truncate" title={d.filename}>{d.filename}</p>
                            <p class="text-[11px] text-white/30 truncate" title={d.url}>{host(d.url)}</p>
                            <p class="text-[11px] mt-0.5 {d.state === 'completed' ? 'text-emerald-400/70' : d.state === 'progressing' ? 'text-blue-300/70' : 'text-amber-400/70'}">
                                {stateLabel(d)}
                            </p>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            {#if d.state === "progressing"}
                                <button
                                    onclick={() => run(() => bucks.downloads.cancel(d.id))}
                                    title="Cancel download"
                                    aria-label="Cancel download"
                                    class="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                ><X size={14} /></button>
                            {:else}
                                {#if d.state === "completed"}
                                    <button
                                        onclick={() => run(() => bucks.downloads.open(d.id))}
                                        title="Open file"
                                        aria-label="Open file"
                                        class="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                                    ><ExternalLink size={14} /></button>
                                {/if}
                                <button
                                    onclick={() => run(() => bucks.downloads.showInFolder(d.id))}
                                    title="Show in folder"
                                    aria-label="Show in folder"
                                    class="w-8 h-8 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                                ><FolderOpen size={14} /></button>
                            {/if}
                        </div>
                    </div>
                    {#if d.state === "progressing"}
                        <div
                            class="h-1.5 rounded-full bg-white/10 overflow-hidden"
                            role="progressbar"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            aria-valuenow={d.totalBytes ? percent(d) : undefined}
                            aria-label="Download progress"
                        >
                            {#if d.totalBytes}
                                <div class="h-full bg-blue-500 transition-[width] duration-300" style:width="{percent(d)}%"></div>
                            {:else}
                                <div class="h-full w-1/3 bg-blue-500/70 animate-pulse"></div>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>
