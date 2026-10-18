<script lang="ts">
    import { ipfsStore } from '$lib/ipfsStore';
    import { browserStore } from '$lib/stores';
    import { errorMessage, shortId } from '$lib/format';
    import SendToDevicesButton from '$lib/devices/SendToDevicesButton.svelte';

    let pinInput = $state('');
    let pinning = $state(false);
    let error = $state('');

    async function addPin() {
        const cid = pinInput.trim().replace(/^ipfs:\/\//i, '').replace(/^\/ipfs\//, '');
        if (!cid) return;
        pinning = true;
        error = '';
        try {
            await ipfsStore.pinCid(cid);
            pinInput = '';
        } catch (e) {
            error = errorMessage(e);
        } finally {
            pinning = false;
        }
    }

    async function unpin(cid: string) {
        error = '';
        try {
            await ipfsStore.unpinCid(cid);
        } catch (e) {
            error = errorMessage(e);
        }
    }
</script>

<section class="space-y-3">
    <h2 class="text-sm font-medium text-zinc-300">Pin a CID</h2>
    <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); void addPin(); }}>
        <input
            bind:value={pinInput}
            placeholder="Qm… or bafy…"
            aria-label="CID to pin"
            class="flex-1 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/40 transition-colors font-mono"
        />
        <button type="submit" disabled={pinning || !pinInput.trim()}
                class="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm transition-colors">
            {pinning ? 'Pinning…' : 'Pin'}
        </button>
    </form>
    {#if error}<p class="text-xs text-red-400">{error}</p>{/if}
</section>

<section class="space-y-3">
    <div class="flex items-center justify-between">
        <h2 class="text-sm font-medium text-zinc-300">
            Pinned content
            {#if $ipfsStore.pins.length > 0}
                <span class="ml-1.5 text-zinc-600">({$ipfsStore.pins.length})</span>
            {/if}
        </h2>
        <button onclick={() => ipfsStore.listPins()} class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            {$ipfsStore.isLoadingPins ? 'Loading…' : 'Refresh'}
        </button>
    </div>
    {#if $ipfsStore.isLoadingPins && $ipfsStore.pins.length === 0}
        <div class="text-xs text-zinc-600 py-4 text-center">Loading pins…</div>
    {:else if $ipfsStore.pins.length === 0}
        <div class="text-xs text-zinc-600 py-4 text-center rounded-xl border border-white/5">No pinned content yet</div>
    {:else}
        <div class="rounded-2xl border border-white/5 overflow-hidden divide-y divide-white/[0.04]">
            {#each $ipfsStore.pins as pin (pin.cid)}
                <div class="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors group focus-within:bg-white/[0.02]">
                    <div class="flex items-center gap-3 min-w-0">
                        <span class="w-1.5 h-1.5 rounded-full bg-blue-500/60 shrink-0"></span>
                        <span class="font-mono text-xs text-zinc-300 truncate" title={pin.cid}>{shortId(pin.cid, 10, 8)}</span>
                        <span class="text-xs text-zinc-600">{pin.pin_type}</span>
                    </div>
                    <div class="flex items-center gap-3 min-w-0">
                        <SendToDevicesButton cid={pin.cid} compact />
                        <div class="flex gap-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                            <button onclick={() => browserStore.createTab(`ipfs://${pin.cid}`)} class="text-xs text-blue-400 hover:text-blue-300 transition-colors">Open</button>
                            <button onclick={() => unpin(pin.cid)} class="text-xs text-red-400/70 hover:text-red-400 transition-colors">Unpin</button>
                        </div>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</section>
