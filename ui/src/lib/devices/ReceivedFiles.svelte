<script lang="ts">
    import { ExternalLink, Pin, X, Inbox } from 'lucide-svelte';
    import { clock, devicesStore, type ReceivedShare } from '$lib/devicesStore';
    import { ipfsStore } from '$lib/ipfsStore';
    import { browserStore } from '$lib/stores';
    import { formatBytes, relativeTime, shortId } from '$lib/format';

    /** Files paired devices shared with this one: open, pin locally, or dismiss. */
    let { files }: { files: ReceivedShare[] } = $props();

    let busy = $state<string | null>(null);
    let error = $state('');

    const pinnedCids = $derived(new Set($ipfsStore.pins.map((p) => p.cid)));
    const key = (f: ReceivedShare) => `${f.from}:${f.cid}`;

    async function pin(f: ReceivedShare) {
        busy = key(f);
        error = '';
        const r = await devicesStore.pin(f.cid);
        busy = null;
        if (!r.ok) error = `Could not pin ${f.name || f.cid}: ${r.error}`;
    }

    async function dismiss(f: ReceivedShare) {
        busy = key(f);
        error = '';
        const r = await devicesStore.dismiss(f.cid, f.from);
        busy = null;
        if (!r.ok) error = r.error;
    }
</script>

<section class="space-y-2" aria-labelledby="received-files-heading">
    <h3 id="received-files-heading" class="text-xs font-medium text-zinc-400">
        Received from your devices
        {#if files.length > 0}<span class="ml-1 text-zinc-600">({files.length})</span>{/if}
    </h3>
    {#if files.length === 0}
        <p class="flex items-center gap-2 text-xs text-zinc-600 py-3 px-4 rounded-xl border border-white/5">
            <Inbox size={14} /> Nothing received yet. Use "Send to my devices" on the other device.
        </p>
    {:else}
        <ul class="rounded-2xl border border-white/5 overflow-hidden divide-y divide-white/[0.04]">
            {#each files as f (key(f))}
                {@const pinned = f.pinned || pinnedCids.has(f.cid)}
                <li class="flex items-center gap-3 px-4 py-3">
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="text-sm text-zinc-200 truncate" title={f.name || f.cid}>{f.name || shortId(f.cid, 10, 8)}</span>
                            {#if pinned}
                                <span class="text-[10px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 shrink-0">pinned</span>
                            {/if}
                        </div>
                        <div class="text-[11px] text-zinc-500 mt-0.5 flex flex-wrap gap-x-2">
                            <span>from {f.fromName || shortId(f.from)}</span>
                            <span>{f.size === null ? 'size unknown' : formatBytes(f.size)}</span>
                            <span title={new Date(f.ts).toLocaleString()}>{relativeTime(f.ts, $clock)}</span>
                            <span class="font-mono text-zinc-600" title={f.cid}>{shortId(f.cid, 8, 6)}</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                        <button type="button" onclick={() => browserStore.createTab(`ipfs://${f.cid}`)}
                                aria-label={`Open ${f.name || f.cid} in a new tab`}
                                class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-blue-300 hover:bg-blue-500/10 transition-colors">
                            <ExternalLink size={12} /> Open
                        </button>
                        {#if !pinned}
                            <button type="button" onclick={() => pin(f)} disabled={busy !== null}
                                    aria-label={`Pin ${f.name || f.cid} on this device`}
                                    class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-zinc-300 hover:bg-white/[0.06] disabled:opacity-40 transition-colors">
                                <Pin size={12} /> {busy === key(f) ? 'Pinning…' : 'Pin'}
                            </button>
                        {/if}
                        <button type="button" onclick={() => dismiss(f)} disabled={busy !== null}
                                aria-label={`Dismiss ${f.name || f.cid}`} title="Remove from this list (does not unpin)"
                                class="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] disabled:opacity-40 transition-colors">
                            <X size={12} />
                        </button>
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
    {#if error}<p class="text-xs text-red-400">{error}</p>{/if}
</section>
