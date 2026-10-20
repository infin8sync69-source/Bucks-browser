<script lang="ts">
    let {
        label,
        value,
        placeholder = '',
        description = '',
        mono = true,
        onchange,
    }: {
        label: string;
        value: string;
        placeholder?: string;
        description?: string;
        mono?: boolean;
        onchange: (value: string) => void;
    } = $props();
</script>

<label class="block p-3 rounded-2xl border border-line bg-surface-1 space-y-1.5">
    <span class="block text-xs text-fg-subtle">{label}</span>
    <input
        type="text"
        {value}
        {placeholder}
        spellcheck="false"
        autocomplete="off"
        onchange={(e) => onchange((e.currentTarget as HTMLInputElement).value.trim())}
        class="w-full bg-scrim/30 border border-line rounded-xl px-3 py-2 text-sm text-fg-muted placeholder-fg-faint outline-none focus:border-accent/40 transition-colors {mono ? 'font-mono' : ''}"
    />
    {#if description}<span class="block text-2xs text-fg-faint">{description}</span>{/if}
</label>
