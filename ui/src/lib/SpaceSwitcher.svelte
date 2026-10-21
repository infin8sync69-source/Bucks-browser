<script lang="ts">
    // Spaces: separate sets of tabs (Personal, Work, a project). The strip shows the active space.
    import { tick } from "svelte";
    import { Check, Plus, Pencil, Trash2 } from "lucide-svelte";
    import { browserStore, activeSpace, TAB_COLORS, type TabColor } from "./stores";
    import { pushOverlay, popOverlay } from "./uiState";
    import { tabColorClass } from "./tabColors";

    let open = $state(false);
    let wrapEl = $state<HTMLDivElement | null>(null);
    let editing = $state<string | null>(null); // space id, or "new"
    let name = $state("");
    let color = $state<TabColor>("violet");
    let nameEl = $state<HTMLInputElement | null>(null);

    $effect(() => {
        if (!open) return;
        pushOverlay();
        return popOverlay;
    });

    function onWindowClick(e: MouseEvent) {
        if (open && wrapEl && !e.composedPath().includes(wrapEl)) close();
    }

    function close() {
        open = false;
        editing = null;
    }

    async function edit(id: string | "new") {
        const sp = $browserStore.spaces.find((s) => s.id === id);
        name = sp?.name ?? "";
        color = sp?.color ?? (TAB_COLORS[$browserStore.spaces.length % TAB_COLORS.length] as TabColor);
        editing = id;
        await tick();
        nameEl?.select();
    }

    function save(e: Event) {
        e.preventDefault();
        if (editing === "new") browserStore.createSpace(name, color);
        else if (editing) browserStore.updateSpace(editing, { name, color });
        close();
    }

    function tabCount(id: string) {
        return $browserStore.tabs.filter((t) => t.spaceId === id && !t.isAgentTab && !t.private).length;
    }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => e.key === "Escape" && open && close()} />

<div bind:this={wrapEl} class="no-drag relative flex-shrink-0">
    <button
        onclick={() => (open ? close() : (open = true))}
        title={`Space: ${$activeSpace?.name ?? ""}`}
        aria-label="Spaces"
        aria-expanded={open}
        class="h-8 max-w-[110px] pl-2 pr-2.5 flex items-center gap-1.5 rounded-xl bg-surface-2 hover:bg-surface-4 border border-line-subtle text-fg-subtle hover:text-fg transition-colors"
    >
        <span class="w-2 h-2 rounded-full flex-shrink-0 {tabColorClass($activeSpace?.color)}"></span>
        <span class="text-3xs font-bold tracking-tight truncate">{$activeSpace?.name}</span>
    </button>

    {#if open}
        <div class="absolute top-11 left-0 w-60 p-1.5 rounded-2xl bg-surface-raised/98 border border-line-strong shadow-2xl z-popover text-xs text-fg-muted">
            <p class="px-2.5 pt-1 pb-1.5 text-3xs uppercase tracking-wider text-fg-faint">Spaces</p>
            {#each $browserStore.spaces as sp (sp.id)}
                <div class="group flex items-center rounded-xl hover:bg-surface-2">
                    <button class="flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 text-left" onclick={() => { browserStore.switchSpace(sp.id); close(); }}>
                        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0 {tabColorClass(sp.color)}"></span>
                        <span class="truncate">{sp.name}</span>
                        <span class="ml-auto text-3xs text-fg-faint">{tabCount(sp.id)}</span>
                        {#if sp.id === $browserStore.activeSpaceId}<Check size={12} class="text-accent-fg-strong flex-shrink-0" />{/if}
                    </button>
                    <button class="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 text-fg-faint hover:text-fg" title="Edit space" aria-label={`Edit ${sp.name}`} onclick={() => edit(sp.id)}><Pencil size={11} /></button>
                    {#if $browserStore.spaces.length > 1}
                        <button class="p-1.5 mr-1 rounded-lg opacity-0 group-hover:opacity-100 text-fg-faint hover:text-danger-fg-strong" title="Delete space (its tabs move to another space)" aria-label={`Delete ${sp.name}`} onclick={() => browserStore.deleteSpace(sp.id)}><Trash2 size={11} /></button>
                    {/if}
                </div>
            {/each}

            {#if editing}
                <form onsubmit={save} class="mt-1 p-2 rounded-xl bg-surface-1 border border-line-subtle space-y-2">
                    <input bind:this={nameEl} bind:value={name} maxlength="40" placeholder="Space name"
                        class="w-full px-2.5 py-1.5 rounded-lg bg-surface-2 border border-line-strong outline-none focus:border-accent/40 text-fg" />
                    <div class="flex items-center gap-1.5">
                        {#each TAB_COLORS as c (c)}
                            <button type="button" onclick={() => (color = c as TabColor)} aria-label={`Colour ${c}`}
                                class="w-4 h-4 rounded-full {tabColorClass(c)} {color === c ? 'ring-2 ring-fg/70' : ''}"></button>
                        {/each}
                        <button type="submit" class="ml-auto px-2.5 py-1 rounded-lg bg-accent/20 border border-accent/30 text-accent-fg-strong text-2xs">{editing === "new" ? "Create" : "Save"}</button>
                    </div>
                </form>
            {:else}
                <button class="w-full flex items-center gap-2 px-2.5 py-2 mt-1 rounded-xl hover:bg-surface-2 text-fg-subtle hover:text-fg" onclick={() => edit("new")}>
                    <Plus size={13} /> New space
                </button>
            {/if}
        </div>
    {/if}
</div>
