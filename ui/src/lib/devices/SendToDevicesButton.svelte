<script lang="ts">
    import { Send } from 'lucide-svelte';
    import { devicesStore } from '$lib/devicesStore';

    /**
     * Offers a CID to every paired device. Disabled (with a tooltip) when nothing is paired.
     * `compact` renders an icon-only button for dense rows.
     */
    let { cid, name, size, compact = false }: { cid: string; name?: string; size?: number; compact?: boolean } = $props();

    let sending = $state(false);
    let message = $state('');
    let failed = $state(false);

    const status = $derived($devicesStore.status);
    const pairedCount = $derived(status?.paired.length ?? 0);
    const disabledReason = $derived(
        !status
            ? ($devicesStore.loadError ?? 'Device pairing is not available yet')
            : pairedCount === 0
              ? 'Pair a device first (IPFS page, Devices section) to send files to it'
              : '',
    );
    const tooltip = $derived(disabledReason || `Send to ${pairedCount} paired device${pairedCount === 1 ? '' : 's'}`);

    async function send() {
        sending = true;
        message = '';
        failed = false;
        const req: { cid: string; name?: string; size?: number } = { cid };
        if (name) req.name = name;
        if (typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) req.size = size;
        const r = await devicesStore.share(req);
        sending = false;
        if (!r.ok) {
            failed = true;
            message = `Could not send: ${r.error}`;
        } else if (r.value.onlinePeers > 0) {
            message = `Sent to ${r.value.onlinePeers} online device${r.value.onlinePeers === 1 ? '' : 's'}`;
        } else {
            message = 'Queued; will deliver when your devices come online';
        }
    }
</script>

<span class="inline-flex items-center gap-2 min-w-0 {compact ? 'flex-row-reverse' : ''}">
    <!-- aria-disabled (not disabled) keeps the button focusable so the reason stays reachable as a tooltip. -->
    <button
        type="button"
        onclick={() => { if (!disabledReason && !sending) void send(); }}
        aria-disabled={sending || !!disabledReason}
        aria-label={compact ? 'Send to my devices' : undefined}
        title={tooltip}
        class={(compact
            ? 'p-1 rounded-md text-zinc-500 transition-colors shrink-0 '
            : 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] text-xs text-zinc-200 transition-colors shrink-0 ') +
            (sending || disabledReason
                ? 'opacity-40 cursor-not-allowed'
                : compact ? 'hover:text-blue-300 hover:bg-blue-500/10' : 'hover:bg-white/10')}
    >
        <Send size={12} class={sending ? 'animate-pulse' : ''} />
        {#if !compact}{sending ? 'Sending…' : 'Send to my devices'}{/if}
    </button>
    {#if message}
        <span class="text-[11px] truncate {failed ? 'text-red-400' : 'text-emerald-400'}" role="status" title={message}>{message}</span>
    {/if}
</span>
