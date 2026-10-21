<script lang="ts">
    import { Folder, File as FileIcon, ChevronRight, ArrowUp } from 'lucide-svelte';
    import { ipfsStore, type IpfsLsEntry } from '$lib/ipfsStore';
    import { browserStore } from '$lib/stores';
    import { errorMessage, formatBytes } from '$lib/format';

    let input = $state('');
    let currentPath = $state('');
    let entries = $state<IpfsLsEntry[]>([]);
    let loading = $state(false);
    let error = $state('');

    /** "ipfs://cid/a", "/ipfs/cid/a" or "cid/a" → "/ipfs/cid/a" (ipns kept as /ipns/…). */
    function toPath(raw: string): string {
        const v = raw.trim().replace(/^ipfs:\/\//i, '/ipfs/').replace(/^ipns:\/\//i, '/ipns/');
        if (!v) return '';
        const path = v.startsWith('/') ? v : `/ipfs/${v}`;
        return path.replace(/\/+$/, '');
    }

    /** "/ipfs/cid/a/b" → "ipfs://cid/a/b" */
    function toUri(path: string): string {
        return path.replace(/^\/ipfs\//, 'ipfs://').replace(/^\/ipns\//, 'ipns://');
    }

    const segments = $derived(currentPath.split('/').filter(Boolean));
    // "/ipfs/<cid>" has two segments; anything deeper has a parent directory to go up to.
    const canGoUp = $derived(segments.length > 2);

    async function load(path: string) {
        if (!path) return;
        loading = true;
        error = '';
        try {
            entries = await ipfsStore.ls(path);
            currentPath = path;
            input = toUri(path);
        } catch (e) {
            entries = [];
            error = errorMessage(e);
        } finally {
            loading = false;
        }
    }

    function go() {
        void load(toPath(input));
    }

    function openEntry(entry: IpfsLsEntry) {
        const next = `${currentPath}/${entry.name || entry.cid}`;
        if (entry.type === 'dir') void load(next);
        else browserStore.createTab(toUri(next));
    }

    function up() {
        if (canGoUp) void load('/' + segments.slice(0, -1).join('/'));
    }
</script>

<section class="space-y-3">
    <h2 class="text-md font-medium text-fg-muted">Browse a CID or path</h2>
    <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); go(); }}>
        <input
            bind:value={input}
            placeholder="CID, /ipfs/<cid>/path or ipfs://…"
            aria-label="CID or IPFS path"
            class="flex-1 bg-surface-1 border border-line-subtle rounded-xl px-4 py-2 text-md text-fg placeholder-fg-faint focus:outline-none focus:border-accent/40 transition-colors font-mono"
        />
        <button type="submit" disabled={loading || !input.trim()}
                class="px-4 py-2 rounded-xl bg-surface-3 hover:bg-surface-4 disabled:opacity-40 disabled:cursor-not-allowed text-md transition-colors">
            {loading ? '…' : 'List'}
        </button>
        <button type="button" disabled={!input.trim()}
                onclick={() => { const p = toPath(input); if (p) browserStore.createTab(toUri(p)); }}
                class="px-4 py-2 rounded-xl bg-surface-3 hover:bg-surface-4 disabled:opacity-40 disabled:cursor-not-allowed text-md transition-colors">
            Open
        </button>
    </form>

    {#if error}<p class="text-xs text-danger-fg">{error}</p>{/if}

    {#if currentPath && !error}
        <div class="rounded-2xl border border-line-subtle overflow-hidden">
            <div class="flex items-center gap-2 px-4 py-2 bg-surface-1 text-xs text-fg-faint font-mono">
                {#if canGoUp}
                    <button onclick={up} title="Up one level" class="text-fg-subtle hover:text-fg transition-colors"><ArrowUp size={13} /></button>
                {/if}
                <span class="truncate">{toUri(currentPath)}</span>
            </div>
            {#if entries.length === 0}
                <div class="px-4 py-6 text-xs text-fg-faint text-center">{loading ? 'Loading…' : 'Empty directory'}</div>
            {:else}
                <div class="divide-y divide-line-subtle">
                    {#each entries as entry (entry.cid + entry.name)}
                        <button onclick={() => openEntry(entry)}
                                class="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-1 transition-colors">
                            {#if entry.type === 'dir'}
                                <Folder size={14} class="text-accent-fg/80 shrink-0" />
                            {:else}
                                <FileIcon size={14} class="text-fg-faint shrink-0" />
                            {/if}
                            <span class="text-xs text-fg truncate flex-1">{entry.name || entry.cid}</span>
                            <span class="text-3xs text-fg-faint shrink-0">{entry.type === 'dir' ? 'folder' : formatBytes(entry.size)}</span>
                            <ChevronRight size={12} class="text-fg-disabled shrink-0" />
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}
</section>
