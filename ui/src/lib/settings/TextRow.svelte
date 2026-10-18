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

<label class="block p-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] space-y-1.5">
    <span class="block text-[12px] text-white/60">{label}</span>
    <input
        type="text"
        {value}
        {placeholder}
        spellcheck="false"
        autocomplete="off"
        onchange={(e) => onchange((e.currentTarget as HTMLInputElement).value.trim())}
        class="w-full bg-black/30 border border-white/[0.06] rounded-xl px-3 py-2 text-[13px] text-white/80 placeholder-white/20 outline-none focus:border-blue-500/40 transition-colors {mono ? 'font-mono' : ''}"
    />
    {#if description}<span class="block text-[11px] text-white/25">{description}</span>{/if}
</label>
