<script lang="ts">
    import { Unlink } from 'lucide-svelte';
    import { clock, devicesStore, type PairedDevice } from '$lib/devicesStore';
    import { platformLabel, relativeTime, shortId } from '$lib/format';
    import PlatformIcon from './PlatformIcon.svelte';

    /** Paired devices with presence, connection state and an Unpair action (confirmed inline). */
    let { devices }: { devices: PairedDevice[] } = $props();

    let confirming = $state<string | null>(null);
    let busy = $state<string | null>(null);
    let error = $state('');

    async function unpair(peerId: string) {
        busy = peerId;
        error = '';
        const r = await devicesStore.unpair(peerId);
        busy = null;
        confirming = null;
        if (!r.ok) error = r.error;
    }
</script>

<section class="space-y-2" aria-labelledby="paired-devices-heading">
    <h3 id="paired-devices-heading" class="text-xs font-medium text-zinc-400">
        Paired devices
        {#if devices.length > 0}<span class="ml-1 text-zinc-600">({devices.length})</span>{/if}
    </h3>
    {#if devices.length === 0}
        <p class="text-xs text-zinc-600 py-3 px-4 rounded-xl border border-white/5">
            No paired devices yet. Pair one from the list below, or paste its pairing address under "Pair manually".
        </p>
    {:else}
        <ul class="rounded-2xl border border-white/5 overflow-hidden divide-y divide-white/[0.04]">
            {#each devices as d (d.peerId)}
                <li class="flex items-center gap-3 px-4 py-3">
                    <PlatformIcon platform={d.platform} />
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 min-w-0">
                            <span
                                class="w-2 h-2 rounded-full shrink-0 {d.online ? 'bg-emerald-500' : 'bg-zinc-600'}"
                                role="img"
                                aria-label={d.online ? 'Online' : 'Offline'}
                                title={d.online ? 'Online' : 'Offline'}
                            ></span>
                            <span class="text-sm text-zinc-200 truncate">{d.name || shortId(d.peerId)}</span>
                            {#if d.connected}
                                <span class="text-[10px] px-1.5 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-300 shrink-0">connected</span>
                            {/if}
                        </div>
                        <div class="text-[11px] text-zinc-500 mt-0.5 flex flex-wrap gap-x-2">
                            <span>{d.platform ? platformLabel(d.platform) : 'Platform unknown'}{d.version ? ` · v${d.version}` : ''}</span>
                            <span>{d.online ? 'Online' : `Last seen ${relativeTime(d.lastSeen, $clock)}`}</span>
                            <span class="font-mono text-zinc-600" title={d.peerId}>{shortId(d.peerId)}</span>
                        </div>
                    </div>
                    {#if confirming === d.peerId}
                        <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-[11px] text-zinc-400">Unpair?</span>
                            <button type="button" onclick={() => unpair(d.peerId)} disabled={busy !== null}
                                    class="px-2.5 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs disabled:opacity-40 transition-colors">
                                {busy === d.peerId ? 'Unpairing…' : 'Unpair'}
                            </button>
                            <button type="button" onclick={() => (confirming = null)} disabled={busy !== null}
                                    class="px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/10 text-zinc-300 text-xs disabled:opacity-40 transition-colors">
                                Cancel
                            </button>
                        </div>
                    {:else}
                        <button type="button" onclick={() => { confirming = d.peerId; error = ''; }}
                                aria-label={`Unpair ${d.name || d.peerId}`}
                                class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-zinc-400 hover:text-red-300 hover:bg-red-500/10 transition-colors shrink-0">
                            <Unlink size={12} /> Unpair
                        </button>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
    {#if error}<p class="text-xs text-red-400">{error}</p>{/if}
</section>
