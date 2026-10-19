<script lang="ts">
    // Today's agenda, typed by you ("9:30 Standup", "Buy milk") and kept on this computer.
    // A new day starts with an empty list.
    import { onMount } from "svelte";
    import { X } from "lucide-svelte";
    import { agendaFor, dayKey, parseAgendaEntry, withAgendaItem, withAgendaToggled, withoutAgendaItem, type Widget } from "../board";
    import { boardStore } from "../stores";

    let { widget }: { widget: Widget } = $props();

    let today = $state(dayKey());
    let entry = $state("");
    const items = $derived(agendaFor(widget.config, today));

    onMount(() => {
        const t = setInterval(() => (today = dayKey()), 60_000);
        return () => clearInterval(t);
    });

    function add() {
        const item = parseAgendaEntry(entry);
        if (!item) return;
        boardStore.configure(widget.uid, withAgendaItem(widget.config, item, today));
        entry = "";
    }
</script>

<div class="space-y-1.5">
    {#if items.length === 0}
        <p class="text-[11px] text-white/30">Nothing planned. Add something below.</p>
    {/if}
    {#each items as i (i.id)}
        <div class="group flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={i.done} onchange={() => boardStore.configure(widget.uid, withAgendaToggled(widget.config, i.id, today))}
                aria-label="Done: {i.text}" class="accent-emerald-400 flex-shrink-0" />
            {#if i.time}<span class="text-white/40 tabular-nums text-[11px] w-9 flex-shrink-0">{i.time}</span>{/if}
            <span class="truncate {i.done ? 'line-through text-white/25' : 'text-white/75'}">{i.text}</span>
            <button onclick={() => boardStore.configure(widget.uid, withoutAgendaItem(widget.config, i.id, today))} title="Remove" aria-label="Remove {i.text}"
                class="ml-auto opacity-0 group-hover:opacity-100 text-white/30 hover:text-white transition-opacity"><X size={11} /></button>
        </div>
    {/each}
    <form onsubmit={(e) => { e.preventDefault(); add(); }}>
        <input bind:value={entry} placeholder="9:30 Standup, or just a task" aria-label="Add to today"
            class="w-full mt-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-[11px] text-white/80 placeholder-white/25 outline-none focus:border-white/20" />
    </form>
</div>
