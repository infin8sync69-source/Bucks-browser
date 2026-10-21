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
        <p class="text-2xs text-fg-faint">Nothing planned. Add something below.</p>
    {/if}
    {#each items as i (i.id)}
        <div class="group flex items-center gap-2 text-xs">
            <input type="checkbox" checked={i.done} onchange={() => boardStore.configure(widget.uid, withAgendaToggled(widget.config, i.id, today))}
                aria-label="Done: {i.text}" class="accent-success flex-shrink-0" />
            {#if i.time}<span class="text-fg-faint tabular-nums text-2xs w-9 flex-shrink-0">{i.time}</span>{/if}
            <span class="truncate {i.done ? 'line-through text-fg-faint' : 'text-fg-muted'}">{i.text}</span>
            <button onclick={() => boardStore.configure(widget.uid, withoutAgendaItem(widget.config, i.id, today))} title="Remove" aria-label="Remove {i.text}"
                class="ml-auto opacity-0 group-hover:opacity-100 text-fg-faint hover:text-fg transition-opacity"><X size={11} /></button>
        </div>
    {/each}
    <form onsubmit={(e) => { e.preventDefault(); add(); }}>
        <input bind:value={entry} placeholder="9:30 Standup, or just a task" aria-label="Add to today"
            class="w-full mt-1 bg-surface-2 border border-line rounded-lg px-2 py-1.5 text-2xs text-fg-muted placeholder-fg-faint outline-none focus:border-line-emphasis" />
    </form>
</div>
