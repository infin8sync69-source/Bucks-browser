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
    <h2 class="text-md font-medium text-fg-muted">Pin a CID</h2>
    <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); void addPin(); }}>
        <input
            bind:value={pinInput}
            placeholder="Qm… or bafy…"
            aria-label="CID to pin"
            class="flex-1 bg-surface-1 border border-line-subtle rounded-xl px-4 py-2 text-md text-fg placeholder-fg-faint focus:outline-none focus:border-accent/40 transition-colors font-mono"
        />
        <button type="submit" disabled={pinning || !pinInput.trim()}
                class="px-4 py-2 rounded-xl bg-surface-3 hover:bg-surface-4 disabled:opacity-40 disabled:cursor-not-allowed text-md transition-colors">
            {pinning ? 'Pinning…' : 'Pin'}
        </button>
    </form>
    {#if error}<p class="text-xs text-danger-fg">{error}</p>{/if}
</section>

<section class="space-y-3">
    <div class="flex items-center justify-between">
        <h2 class="text-md font-medium text-fg-muted">
            Pinned content
            {#if $ipfsStore.pins.length > 0}
                <span class="ml-1.5 text-fg-faint">({$ipfsStore.pins.length})</span>
            {/if}
        </h2>
        <button onclick={() => ipfsStore.listPins()} class="text-xs text-fg-faint hover:text-fg-muted transition-colors">
            {$ipfsStore.isLoadingPins ? 'Loading…' : 'Refresh'}
        </button>
    </div>
    {#if $ipfsStore.isLoadingPins && $ipfsStore.pins.length === 0}
        <div class="text-xs text-fg-faint py-4 text-center">Loading pins…</div>
    {:else if $ipfsStore.pins.length === 0}
        <div class="text-xs text-fg-faint py-4 text-center rounded-xl border border-line-subtle">No pinned content yet</div>
    {:else}
        <div class="rounded-2xl border border-line-subtle overflow-hidden divide-y divide-line-subtle">
            {#each $ipfsStore.pins as pin (pin.cid)}
                <div class="flex items-center justify-between px-4 py-3 hover:bg-surface-1 transition-colors group focus-within:bg-surface-1">
                    <div class="flex items-center gap-3 min-w-0">
                        <span class="w-1.5 h-1.5 rounded-full bg-accent/60 shrink-0"></span>
                        <span class="font-mono text-xs text-fg-muted truncate" title={pin.cid}>{shortId(pin.cid, 10, 8)}</span>
                        <span class="text-xs text-fg-faint">{pin.pin_type}</span>
                    </div>
                    <div class="flex items-center gap-3 min-w-0">
                        <SendToDevicesButton cid={pin.cid} compact />
                        <div class="flex gap-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                            <button onclick={() => browserStore.createTab(`ipfs://${pin.cid}`)} class="text-xs text-accent-fg hover:text-accent-fg-strong transition-colors">Open</button>
                            <button onclick={() => unpin(pin.cid)} class="text-xs text-danger-fg/70 hover:text-danger-fg transition-colors">Unpin</button>
                        </div>
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</section>
