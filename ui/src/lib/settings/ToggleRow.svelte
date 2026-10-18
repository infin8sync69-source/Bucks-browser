<script lang="ts">
    let {
        label,
        description = '',
        checked,
        onchange,
    }: {
        label: string;
        description?: string;
        checked: boolean;
        onchange: (value: boolean) => void;
    } = $props();
</script>

<div class="flex items-center justify-between gap-4 p-3 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
    <div class="min-w-0">
        <p class="text-[13px] text-white/70">{label}</p>
        {#if description}<p class="text-[11px] text-white/30 mt-0.5">{description}</p>{/if}
    </div>
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onclick={() => onchange(!checked)}
        class="relative w-10 h-6 rounded-full shrink-0 border transition-colors
               {checked ? 'bg-blue-500/60 border-blue-400/50' : 'bg-white/10 border-white/10'}"
    >
        <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform {checked ? 'translate-x-4' : ''}"></span>
    </button>
</div>
