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
    <h3 id="paired-devices-heading" class="text-xs font-medium text-fg-subtle">
        Paired devices
        {#if devices.length > 0}<span class="ml-1 text-fg-faint">({devices.length})</span>{/if}
    </h3>
    {#if devices.length === 0}
        <p class="text-xs text-fg-faint py-3 px-4 rounded-xl border border-line-subtle">
            No paired devices yet. Pair one from the list below, or paste its pairing address under "Pair manually".
        </p>
    {:else}
        <ul class="rounded-2xl border border-line-subtle overflow-hidden divide-y divide-line-subtle">
            {#each devices as d (d.peerId)}
                <li class="flex items-center gap-3 px-4 py-3">
                    <PlatformIcon platform={d.platform} />
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 min-w-0">
                            <span
                                class="w-2 h-2 rounded-full shrink-0 {d.online ? 'bg-success' : 'bg-fg-disabled'}"
                                role="img"
                                aria-label={d.online ? 'Online' : 'Offline'}
                                title={d.online ? 'Online' : 'Offline'}
                            ></span>
                            <span class="text-md text-fg truncate">{d.name || shortId(d.peerId)}</span>
                            {#if d.connected}
                                <span class="text-3xs px-1.5 py-0.5 rounded-md bg-accent/10 border border-accent/20 text-accent-fg-strong shrink-0">connected</span>
                            {/if}
                        </div>
                        <div class="text-2xs text-fg-faint mt-0.5 flex flex-wrap gap-x-2">
                            <span>{d.platform ? platformLabel(d.platform) : 'Platform unknown'}{d.version ? ` · v${d.version}` : ''}</span>
                            <span>{d.online ? 'Online' : `Last seen ${relativeTime(d.lastSeen, $clock)}`}</span>
                            <span class="font-mono text-fg-faint" title={d.peerId}>{shortId(d.peerId)}</span>
                        </div>
                    </div>
                    {#if confirming === d.peerId}
                        <div class="flex items-center gap-1.5 shrink-0">
                            <span class="text-2xs text-fg-subtle">Unpair?</span>
                            <button type="button" onclick={() => unpair(d.peerId)} disabled={busy !== null}
                                    class="px-2.5 py-1 rounded-lg bg-danger/20 hover:bg-danger/30 text-danger-fg-strong text-xs disabled:opacity-40 transition-colors">
                                {busy === d.peerId ? 'Unpairing…' : 'Unpair'}
                            </button>
                            <button type="button" onclick={() => (confirming = null)} disabled={busy !== null}
                                    class="px-2.5 py-1 rounded-lg bg-surface-3 hover:bg-surface-4 text-fg-muted text-xs disabled:opacity-40 transition-colors">
                                Cancel
                            </button>
                        </div>
                    {:else}
                        <button type="button" onclick={() => { confirming = d.peerId; error = ''; }}
                                aria-label={`Unpair ${d.name || d.peerId}`}
                                class="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-fg-subtle hover:text-danger-fg-strong hover:bg-danger/10 transition-colors shrink-0">
                            <Unlink size={12} /> Unpair
                        </button>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
    {#if error}<p class="text-xs text-danger-fg">{error}</p>{/if}
</section>
