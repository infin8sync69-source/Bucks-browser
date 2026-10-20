<script lang="ts">
    import { UserPlus } from 'lucide-svelte';
    import { clock, devicesStore, type DiscoveredDevice } from '$lib/devicesStore';
    import { platformLabel, relativeTime, shortId } from '$lib/format';
    import PlatformIcon from './PlatformIcon.svelte';

    /** Unpaired Bucks devices announcing themselves on the topic, each with a Pair button. */
    let { devices }: { devices: DiscoveredDevice[] } = $props();

    let busy = $state<string | null>(null);
    let error = $state('');

    async function pair(d: DiscoveredDevice) {
        busy = d.peerId;
        error = '';
        const r = await devicesStore.pair({ peerId: d.peerId, name: d.name, addrs: d.addrs });
        busy = null;
        if (!r.ok) error = r.error;
    }
</script>

<section class="space-y-2" aria-labelledby="discovered-devices-heading">
    <div>
        <h3 id="discovered-devices-heading" class="text-xs font-medium text-fg-subtle">Nearby Bucks devices</h3>
        <p class="text-2xs text-fg-faint mt-0.5">Pair here, then pair back from the other device so files can flow both ways.</p>
    </div>
    {#if devices.length === 0}
        <p class="text-xs text-fg-faint py-3 px-4 rounded-xl border border-line-subtle">
            No unpaired devices seen in the last few minutes. Bucks on the same network shows up here automatically; otherwise use "Pair manually".
        </p>
    {:else}
        <ul class="rounded-2xl border border-line-subtle overflow-hidden divide-y divide-line-subtle">
            {#each devices as d (d.peerId)}
                <li class="flex items-center gap-3 px-4 py-3">
                    <PlatformIcon platform={d.platform} />
                    <div class="min-w-0 flex-1">
                        <div class="text-md text-fg truncate">{d.name || shortId(d.peerId)}</div>
                        <div class="text-2xs text-fg-faint mt-0.5 flex flex-wrap gap-x-2">
                            <span>{platformLabel(d.platform)}{d.version ? ` · v${d.version}` : ''}</span>
                            <span>Seen {relativeTime(d.lastSeen, $clock)}</span>
                            <span class="font-mono text-fg-faint" title={d.peerId}>{shortId(d.peerId)}</span>
                        </div>
                    </div>
                    <button type="button" onclick={() => pair(d)} disabled={busy !== null}
                            aria-label={`Pair with ${d.name || d.peerId}`}
                            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent/70 hover:bg-accent-emphasis-hover disabled:opacity-40 text-xs font-medium transition-colors shrink-0">
                        <UserPlus size={12} /> {busy === d.peerId ? 'Pairing…' : 'Pair'}
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
    {#if error}<p class="text-xs text-danger-fg">{error}</p>{/if}
</section>
