<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
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

<div class="min-h-full bg-canvas text-fg px-8 py-10 max-w-2xl mx-auto space-y-6" in:fade={{ duration: motion.moderate }}>
    <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-2xl bg-surface-2 border border-line-strong flex items-center justify-center">
                <Download size={16} class="text-accent-fg" />
            </div>
            <div>
                <h1 class="text-lg font-semibold tracking-tight">Downloads</h1>
                <p class="text-2xs text-fg-faint">{items.length} item{items.length === 1 ? "" : "s"}</p>
            </div>
        </div>
        {#if hasFinished}
            <button
                onclick={clearAll}
                class="flex items-center gap-2 px-4 py-2 rounded-xl bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger-fg text-xs font-medium transition-all"
            >
                <Trash2 size={12} /> Clear list
            </button>
        {/if}
    </div>

    {#if error}
        <p class="text-xs text-danger-fg bg-danger/10 border border-danger/20 rounded-xl px-3 py-2">{error}</p>
    {/if}

    {#if !loaded}
        <p class="text-sm text-fg-faint py-8 text-center">Loading…</p>
    {:else if sorted.length === 0}
        <div class="text-center py-16 rounded-2xl border border-line-subtle bg-surface-1">
            <Download size={28} class="mx-auto text-fg-disabled mb-3" />
            <p class="text-sm text-fg-faint">No downloads yet</p>
            <p class="text-2xs text-fg-disabled mt-1">Files you download from web pages appear here.</p>
        </div>
    {:else}
        <div class="space-y-2">
            {#each sorted as d (d.id)}
                <div class="rounded-2xl border border-line bg-surface-1 p-4 space-y-3">
                    <div class="flex items-start gap-3">
                        <div class="w-9 h-9 rounded-xl bg-surface-2 flex items-center justify-center shrink-0">
                            <FileIcon size={16} class="text-fg-faint" />
                        </div>
                        <div class="min-w-0 flex-1">
                            <p class="text-sm text-fg-muted truncate" title={d.filename}>{d.filename}</p>
                            <p class="text-2xs text-fg-faint truncate" title={d.url}>{host(d.url)}</p>
                            <p class="text-2xs mt-0.5 {d.state === 'completed' ? 'text-success-fg/70' : d.state === 'progressing' ? 'text-accent-fg-strong/70' : 'text-warning-fg/70'}">
                                {stateLabel(d)}
                            </p>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">
                            {#if d.state === "progressing"}
                                <button
                                    onclick={() => run(() => bucks.downloads.cancel(d.id))}
                                    title="Cancel download"
                                    aria-label="Cancel download"
                                    class="w-8 h-8 flex items-center justify-center rounded-lg text-fg-faint hover:text-danger-fg hover:bg-danger/10 transition-colors"
                                ><X size={14} /></button>
                            {:else}
                                {#if d.state === "completed"}
                                    <button
                                        onclick={() => run(() => bucks.downloads.open(d.id))}
                                        title="Open file"
                                        aria-label="Open file"
                                        class="w-8 h-8 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg hover:bg-surface-4 transition-colors"
                                    ><ExternalLink size={14} /></button>
                                {/if}
                                <button
                                    onclick={() => run(() => bucks.downloads.showInFolder(d.id))}
                                    title="Show in folder"
                                    aria-label="Show in folder"
                                    class="w-8 h-8 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg hover:bg-surface-4 transition-colors"
                                ><FolderOpen size={14} /></button>
                            {/if}
                        </div>
                    </div>
                    {#if d.state === "progressing"}
                        <div
                            class="h-1.5 rounded-full bg-surface-4 overflow-hidden"
                            role="progressbar"
                            aria-valuemin="0"
                            aria-valuemax="100"
                            aria-valuenow={d.totalBytes ? percent(d) : undefined}
                            aria-label="Download progress"
                        >
                            {#if d.totalBytes}
                                <div class="h-full bg-accent transition-[width] duration-moderate" style:width="{percent(d)}%"></div>
                            {:else}
                                <div class="h-full w-1/3 bg-accent/70 animate-pulse"></div>
                            {/if}
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</div>
