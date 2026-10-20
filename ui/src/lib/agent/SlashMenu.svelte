<script lang="ts">
    // Slash-command suggestions above a text box. The parent owns the keyboard (arrows, Tab, Enter).
    import type { SlashCommand } from "./slash";

    let { items, active = 0, onpick }: { items: SlashCommand[]; active?: number; onpick: (c: SlashCommand) => void } = $props();
</script>

<div class="absolute left-0 right-0 bottom-full mb-2 z-float rounded-2xl border border-line-strong bg-surface-overlay/95 backdrop-blur-xl shadow-2xl p-1.5 max-h-[300px] overflow-y-auto" role="listbox" aria-label="Commands">
    {#each items as c, i (c.cmd)}
        <button
            role="option"
            aria-selected={i === active}
            onmousedown={(e) => { e.preventDefault(); onpick(c); }}
            class="w-full text-left px-2.5 py-1.5 rounded-xl transition-colors {i === active ? 'bg-surface-4' : 'hover:bg-surface-2'}"
        >
            <span class="text-xs text-agent-fg-strong font-mono">{c.cmd}</span>
            {#if c.args}<span class="text-2xs text-fg-faint font-mono"> {c.args}</span>{/if}
            {#if c.soul}<span class="ml-1.5 text-3xs uppercase tracking-wider text-fg-faint">Soul Engine</span>{/if}
            <span class="block text-2xs text-fg-faint leading-snug">{c.desc}</span>
        </button>
    {/each}
</div>
