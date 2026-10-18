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
            <h2 id="devices-heading" class="text-sm font-medium text-zinc-300">Devices</h2>
            <p class="text-[11px] text-zinc-600">Pair your Bucks installs to send files between them over IPFS.</p>
        </div>
        <button type="button" onclick={refresh} disabled={refreshing} aria-label="Refresh devices"
                class="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] disabled:opacity-40 transition-colors">
            <RefreshCw size={14} class={refreshing ? 'animate-spin' : ''} />
        </button>
    </div>

    <div class="flex items-center gap-2 text-xs" role="status" data-testid="devices-status">
        {#if loadError && !status}
            <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
            <span class="text-red-300">{loadError}</span>
        {:else if !status}
            <span class="w-2 h-2 rounded-full bg-zinc-500 animate-pulse shrink-0"></span>
            <span class="text-zinc-500">Loading devices…</span>
        {:else if !status.ready}
            <span class="w-2 h-2 rounded-full shrink-0 {status.error ? 'bg-red-500' : 'bg-yellow-400 animate-pulse'}"></span>
            <span class={status.error ? 'text-red-300' : 'text-zinc-400'}>{status.error ?? 'Waiting for the IPFS node…'}</span>
        {:else}
            <span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
            <span class="text-zinc-400">
                Listening for your devices
                {#if status.paired.length > 0}
                    · {status.paired.filter((d) => d.online).length} of {status.paired.length} online
                {/if}
            </span>
        {/if}
    </div>
    {#if loadError && status}
        <p class="text-[11px] text-red-400/80">{loadError} Showing the last known state.</p>
    {/if}

    {#if status}
        <ThisDevice self={status.self} />
        <PairedDevices devices={status.paired} />
        <ReceivedFiles files={status.received} />
        <DiscoveredDevices devices={status.discovered} />
        <PairManually selfPeerId={status.self.peerId} />
    {/if}
</section>
