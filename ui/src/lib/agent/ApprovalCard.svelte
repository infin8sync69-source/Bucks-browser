<script lang="ts">
    // The agent wants to change something (click, type, open a page, pin, install an app…): allow
    // or refuse. Without an answer the action is refused when the time runs out. For an app, the
    // card lists what Bucks itself found the app asks for (design-system permission list).
    import { onMount } from "svelte";
    import { ShieldAlert } from "lucide-svelte";
    import type { PendingApproval } from "$lib/swarmStore";
    import "$design/components/index.js";

    let { approval, onanswer }: { approval: PendingApproval; onanswer: (yes: boolean) => void } = $props();

    let now = $state(Date.now());
    onMount(() => {
        const t = setInterval(() => (now = Date.now()), 500);
        return () => clearInterval(t);
    });
    const left = $derived(Math.max(0, Math.ceil((approval.expiresAt - now) / 1000)));
    const permissions = $derived(approval.app?.action === 'install' ? approval.app.permissions : approval.app?.action === 'update' ? approval.app.added : undefined);
    const where = $derived(approval.app ? 'Bucks reviewed this app itself.' : 'The agent wants to do this in your tab.');

    let list: (HTMLElement & { items: unknown }) | undefined = $state();
    $effect(() => {
        if (list && permissions) list.items = permissions.map((p) => ({ ...p, icon: p.id.startsWith('network:') ? 'wifi' : 'shield' }));
    });
</script>

<div class="rounded-2xl border border-warning/25 bg-warning/6 p-3" role="alertdialog" aria-label="The agent asks: {approval.label}">
    <div class="flex items-start gap-2">
        <ShieldAlert size={15} class="text-warning-fg-strong/80 mt-0.5 flex-shrink-0" />
        <div class="min-w-0 flex-1">
            <p class="text-xs text-fg-muted break-words">{approval.label}</p>
            <p class="text-3xs text-fg-faint mt-0.5">{where} Refused in {left} s if you do nothing.</p>
        </div>
    </div>
    {#if permissions}
        <bucks-permission-list bind:this={list} class="block mt-2.5" empty-text="It asks for nothing: no network, no devices, no access to your node."></bucks-permission-list>
    {/if}
    <div class="flex gap-2 mt-2.5">
        <button onclick={() => onanswer(true)} class="flex-1 py-1.5 rounded-xl bg-success/20 hover:bg-success/30 text-success-fg-strong text-xs transition-colors">Allow</button>
        <button onclick={() => onanswer(false)} class="flex-1 py-1.5 rounded-xl bg-surface-3 hover:bg-surface-4 text-fg-muted text-xs transition-colors">Refuse</button>
    </div>
</div>
