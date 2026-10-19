<script lang="ts">
    // The agent wants to change something (click, type, open a page, pin…): allow or refuse.
    // Without an answer the action is refused when the time runs out.
    import { onMount } from "svelte";
    import { ShieldAlert } from "lucide-svelte";
    import type { PendingApproval } from "$lib/swarmStore";

    let { approval, onanswer }: { approval: PendingApproval; onanswer: (yes: boolean) => void } = $props();

    let now = $state(Date.now());
    onMount(() => {
        const t = setInterval(() => (now = Date.now()), 500);
        return () => clearInterval(t);
    });
    const left = $derived(Math.max(0, Math.ceil((approval.expiresAt - now) / 1000)));
</script>

<div class="rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-3" role="alertdialog" aria-label="The agent asks: {approval.label}">
    <div class="flex items-start gap-2">
        <ShieldAlert size={15} class="text-amber-200/80 mt-0.5 flex-shrink-0" />
        <div class="min-w-0 flex-1">
            <p class="text-[12px] text-white/85 break-words">{approval.label}</p>
            <p class="text-[10px] text-white/35 mt-0.5">The agent wants to do this in your tab. Refused in {left} s if you do nothing.</p>
        </div>
    </div>
    <div class="flex gap-2 mt-2.5">
        <button onclick={() => onanswer(true)} class="flex-1 py-1.5 rounded-xl bg-emerald-400/20 hover:bg-emerald-400/30 text-emerald-100 text-[12px] transition-colors">Allow</button>
        <button onclick={() => onanswer(false)} class="flex-1 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/10 text-white/70 text-[12px] transition-colors">Refuse</button>
    </div>
</div>
