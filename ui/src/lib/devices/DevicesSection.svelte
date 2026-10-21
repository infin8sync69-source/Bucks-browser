<script lang="ts">
    import { RefreshCw } from 'lucide-svelte';
    import { devicesStore } from '$lib/devicesStore';
    import ThisDevice from './ThisDevice.svelte';
    import PairedDevices from './PairedDevices.svelte';
    import DiscoveredDevices from './DiscoveredDevices.svelte';
    import PairManually from './PairManually.svelte';
    import ReceivedFiles from './ReceivedFiles.svelte';

    /** "Devices" block of the IPFS page: pair Bucks installs and exchange files between them. */
    const status = $derived($devicesStore.status);
    const loadError = $derived($devicesStore.loadError);
    let refreshing = $state(false);

    async function refresh() {
        refreshing = true;
        await devicesStore.refresh();
        refreshing = false;
    }
</script>

<section class="space-y-4" aria-labelledby="devices-heading" data-testid="devices-section">
    <div class="flex items-center justify-between gap-3">
        <div>
            <h2 id="devices-heading" class="text-md font-medium text-fg-muted">Devices</h2>
            <p class="text-2xs text-fg-faint">Pair your Bucks installs to send files between them over IPFS.</p>
        </div>
        <button type="button" onclick={refresh} disabled={refreshing} aria-label="Refresh devices"
                class="p-1.5 rounded-lg text-fg-faint hover:text-fg hover:bg-surface-3 disabled:opacity-40 transition-colors">
            <RefreshCw size={14} class={refreshing ? 'animate-spin' : ''} />
        </button>
    </div>

    <div class="flex items-center gap-2 text-xs" role="status" data-testid="devices-status">
        {#if loadError && !status}
            <span class="w-2 h-2 rounded-full bg-danger shrink-0"></span>
            <span class="text-danger-fg-strong">{loadError}</span>
        {:else if !status}
            <span class="w-2 h-2 rounded-full bg-fg-faint animate-pulse shrink-0"></span>
            <span class="text-fg-faint">Loading devices…</span>
        {:else if !status.ready}
            <span class="w-2 h-2 rounded-full shrink-0 {status.error ? 'bg-danger' : 'bg-warning animate-pulse'}"></span>
            <span class={status.error ? 'text-danger-fg-strong' : 'text-fg-subtle'}>{status.error ?? 'Waiting for the IPFS node…'}</span>
        {:else}
            <span class="w-2 h-2 rounded-full bg-success shrink-0"></span>
            <span class="text-fg-subtle">
                Listening for your devices
                {#if status.paired.length > 0}
                    · {status.paired.filter((d) => d.online).length} of {status.paired.length} online
                {/if}
            </span>
        {/if}
    </div>
    {#if loadError && status}
        <p class="text-2xs text-danger-fg/80">{loadError} Showing the last known state.</p>
    {/if}

    {#if status}
        <ThisDevice self={status.self} />
        <PairedDevices devices={status.paired} />
        <ReceivedFiles files={status.received} />
        <DiscoveredDevices devices={status.discovered} />
        <PairManually selfPeerId={status.self.peerId} />
    {/if}
</section>
