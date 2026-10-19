<script lang="ts">
    // Slash-command suggestions above a text box. The parent owns the keyboard (arrows, Tab, Enter).
    import type { SlashCommand } from "./slash";

    let { items, active = 0, onpick }: { items: SlashCommand[]; active?: number; onpick: (c: SlashCommand) => void } = $props();
</script>

<div class="absolute left-0 right-0 bottom-full mb-2 z-20 rounded-2xl border border-white/10 bg-[#111117]/95 backdrop-blur-xl shadow-2xl p-1.5 max-h-[300px] overflow-y-auto" role="listbox" aria-label="Commands">
    {#each items as c, i (c.cmd)}
        <button
            role="option"
            aria-selected={i === active}
            onmousedown={(e) => { e.preventDefault(); onpick(c); }}
            class="w-full text-left px-2.5 py-1.5 rounded-xl transition-colors {i === active ? 'bg-white/[0.08]' : 'hover:bg-white/[0.05]'}"
        >
            <span class="text-[12px] text-violet-200 font-mono">{c.cmd}</span>
            {#if c.args}<span class="text-[11px] text-white/30 font-mono"> {c.args}</span>{/if}
            {#if c.soul}<span class="ml-1.5 text-[9px] uppercase tracking-wider text-white/25">Soul Engine</span>{/if}
            <span class="block text-[11px] text-white/45 leading-snug">{c.desc}</span>
        </button>
    {/each}
</div>
