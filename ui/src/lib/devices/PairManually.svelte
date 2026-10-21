<script lang="ts">
    import { devicesStore, parsePairInput } from '$lib/devicesStore';

    /** Pair by pasting the other device's peer ID or pairing address. */
    let { selfPeerId }: { selfPeerId: string | null } = $props();

    let input = $state('');
    let busy = $state(false);
    let error = $state('');
    let success = $state('');

    async function submit() {
        error = '';
        success = '';
        const parsed = parsePairInput(input);
        if (!parsed.ok) {
            error = parsed.error;
            return;
        }
        if (selfPeerId && parsed.peerId === selfPeerId) {
            error = "That is this device's own peer ID. Paste the address shown on your other device.";
            return;
        }
        busy = true;
        const r = await devicesStore.pair({ peerId: parsed.value });
        busy = false;
        if (r.ok) {
            input = '';
            success = 'Paired. Now pair back from the other device so it accepts files from this one.';
        } else {
            error = r.error;
        }
    }
</script>

<section class="space-y-2" aria-labelledby="pair-manually-heading">
    <h3 id="pair-manually-heading" class="text-xs font-medium text-fg-subtle">Pair manually</h3>
    <form class="flex gap-2" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input
            bind:value={input}
            oninput={() => { error = ''; success = ''; }}
            placeholder="/ip4/192.168.1.20/tcp/4001/p2p/12D3Koo… or 12D3Koo…"
            aria-label="Peer ID or pairing address of the other device"
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'pair-manually-error' : undefined}
            spellcheck="false"
            autocomplete="off"
            class="flex-1 min-w-0 bg-surface-1 border rounded-xl px-4 py-2 text-xs text-fg placeholder-fg-faint focus:outline-none transition-colors font-mono
                   {error ? 'border-danger/40 focus:border-danger/60' : 'border-line-subtle focus:border-accent/40'}"
        />
        <button type="submit" disabled={busy || !input.trim()}
                class="px-4 py-2 rounded-xl bg-surface-3 hover:bg-surface-4 disabled:opacity-40 disabled:cursor-not-allowed text-md transition-colors shrink-0">
            {busy ? 'Pairing…' : 'Pair'}
        </button>
    </form>
    {#if error}<p id="pair-manually-error" class="text-xs text-danger-fg">{error}</p>{/if}
    {#if success}<p class="text-xs text-success-fg" role="status">{success}</p>{/if}
</section>
