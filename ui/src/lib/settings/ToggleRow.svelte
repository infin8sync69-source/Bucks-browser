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

<div class="flex items-center justify-between gap-4 p-3 rounded-2xl border border-line bg-surface-1">
    <div class="min-w-0">
        <p class="text-sm text-fg-muted">{label}</p>
        {#if description}<p class="text-2xs text-fg-faint mt-0.5">{description}</p>{/if}
    </div>
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onclick={() => onchange(!checked)}
        class="relative w-10 h-6 rounded-full shrink-0 border transition-colors
               {checked ? 'bg-accent/60 border-accent/50' : 'bg-surface-4 border-line-strong'}"
    >
        <span class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-fg transition-transform {checked ? 'translate-x-4' : ''}"></span>
    </button>
</div>
