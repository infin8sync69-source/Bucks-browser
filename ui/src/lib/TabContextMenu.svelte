<script lang="ts">
    // Right-click menu of a tab: new tab, reload, duplicate, pin, mute, rename, colour, move to a
    // space, close variants. The native web view is hidden while it is open (it would cover it).
    import { onMount, tick } from "svelte";
    import { browserStore, TAB_COLORS, type Tab, type TabColor } from "./stores";
    import { pushOverlay, popOverlay } from "./uiState";
    import { tabColorClass } from "./tabColors";

    let { tab, x, y, onclose }: { tab: Tab; x: number; y: number; onclose: () => void } = $props();

    let renaming = $state(false);
    let name = $state("");
    let nameEl = $state<HTMLInputElement | null>(null);
    let menuEl = $state<HTMLDivElement | null>(null);
    let left = $state(0);
    let top = $state(0);

    const otherSpaces = $derived($browserStore.spaces.filter((sp) => sp.id !== tab.spaceId));

    onMount(() => {
        pushOverlay();
        // Keep the menu inside the window.
        void tick().then(() => {
            const w = menuEl?.offsetWidth ?? 220;
            const h = menuEl?.offsetHeight ?? 300;
            left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
            top = Math.max(8, Math.min(y, window.innerHeight - h - 8));
        });
        return popOverlay;
    });

    function run(fn: () => void) {
        fn();
        onclose();
    }

    async function startRename() {
        name = tab.customTitle || tab.title;
        renaming = true;
        await tick();
        nameEl?.select();
    }

    function finishRename(e?: Event) {
        e?.preventDefault();
        browserStore.renameTab(tab.id, name);
        onclose();
    }

    const tabIndex = $derived($browserStore.tabs.findIndex((t) => t.id === tab.id));
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- Click-away layer -->
<button class="fixed inset-0 z-[400] cursor-default" aria-label="Close menu" onclick={onclose} oncontextmenu={(e) => { e.preventDefault(); onclose(); }}></button>

<div
    bind:this={menuEl}
    role="menu"
    style="left: {left || x}px; top: {top || y}px"
    class="fixed z-[401] w-56 py-1.5 rounded-2xl bg-[#0d0d10]/98 border border-white/10 shadow-2xl backdrop-blur-xl text-[12px] text-white/75"
>
    {#if renaming}
        <form onsubmit={finishRename} class="px-2 py-1">
            <input
                bind:this={nameEl}
                bind:value={name}
                onkeydown={(e) => e.key === "Escape" && (e.stopPropagation(), onclose())}
                maxlength="80"
                placeholder="Tab name (empty: page title)"
                class="w-full px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10 outline-none focus:border-blue-400/40 text-white"
            />
            <p class="mt-1 px-1 text-[10px] text-white/30">Enter to save · Esc to cancel</p>
        </form>
    {:else}
        <button role="menuitem" class="item" onclick={() => run(() => browserStore.createTab("bucks://newtab", { spaceId: tab.spaceId, index: tabIndex + 1, private: tab.private }))}>New tab to the right</button>
        <div class="sep"></div>
        <button role="menuitem" class="item" onclick={() => run(() => { browserStore.setActiveTab(tab.id); browserStore.refresh(); })}>Reload</button>
        <button role="menuitem" class="item" onclick={() => run(() => browserStore.duplicateTab(tab.id))}>Duplicate</button>
        <button role="menuitem" class="item" onclick={() => run(() => browserStore.togglePin(tab.id))}>{tab.pinned ? "Unpin" : "Pin"}</button>
        {#if tab.type === "external"}
            <button role="menuitem" class="item" onclick={() => run(() => browserStore.setMuted(tab.id, !tab.muted))}>{tab.muted ? "Unmute site" : "Mute site"}</button>
        {/if}
        <button role="menuitem" class="item" onclick={startRename}>Rename…</button>
        <div class="px-3 py-1.5 flex items-center gap-1.5" role="group" aria-label="Tab colour">
            <button
                onclick={() => run(() => browserStore.setTabColor(tab.id, null))}
                title="No colour"
                aria-label="No colour"
                class="w-4 h-4 rounded-full border {tab.color ? 'border-white/20' : 'border-white/70'} bg-transparent"
            ></button>
            {#each TAB_COLORS as c (c)}
                <button
                    onclick={() => run(() => browserStore.setTabColor(tab.id, c as TabColor))}
                    title={c}
                    aria-label={`Colour ${c}`}
                    class="w-4 h-4 rounded-full {tabColorClass(c)} {tab.color === c ? 'ring-2 ring-white/70' : ''}"
                ></button>
            {/each}
        </div>
        {#if otherSpaces.length && !tab.private}
            <div class="sep"></div>
            <p class="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-white/30">Move to space</p>
            {#each otherSpaces as sp (sp.id)}
                <button role="menuitem" class="item flex items-center gap-2" onclick={() => run(() => browserStore.moveTabToSpace(tab.id, sp.id))}>
                    <span class="w-2 h-2 rounded-full {tabColorClass(sp.color)}"></span>{sp.name}
                </button>
            {/each}
        {/if}
        <div class="sep"></div>
        <button role="menuitem" class="item" onclick={() => run(() => browserStore.closeTab(tab.id))}>Close</button>
        <button role="menuitem" class="item" onclick={() => run(() => browserStore.closeOtherTabs(tab.id))}>Close other tabs</button>
        <button role="menuitem" class="item" onclick={() => run(() => browserStore.closeTabsToRight(tab.id))}>Close tabs to the right</button>
        {#if $browserStore.closedTabs.length}
            <button role="menuitem" class="item" onclick={() => run(() => browserStore.reopenClosedTab())}>Reopen closed tab</button>
        {/if}
    {/if}
</div>

<style>
    .item {
        display: block;
        width: 100%;
        text-align: left;
        padding: 0.4rem 0.85rem;
        border-radius: 0.6rem;
    }
    .item:hover {
        background: rgb(255 255 255 / 0.07);
        color: white;
    }
    .sep {
        height: 1px;
        margin: 0.3rem 0.6rem;
        background: rgb(255 255 255 / 0.06);
    }
</style>
