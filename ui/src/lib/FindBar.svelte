<script lang="ts">
    // Find in page (Ctrl/Cmd+F) for the active web tab. Chromium does the searching and
    // highlighting; this bar only sends the text and shows "match n of m".
    import { tick } from "svelte";
    import { ChevronUp, ChevronDown, X, CaseSensitive } from "lucide-svelte";
    import { bucks } from "./bridge";
    import { activeTab } from "./stores";
    import { findBarOpen, findBarFocus } from "./uiState";

    let text = $state("");
    let matchCase = $state(false);
    let active = $state(0);
    let total = $state<number | null>(null);
    let inputEl = $state<HTMLInputElement | null>(null);
    let tabId = "";

    const close = () => findBarOpen.set(false);

    function search(opts: { findNext?: boolean; forward?: boolean } = {}) {
        const tab = $activeTab;
        if (!tab || tab.type !== "external" || !tab.viewCreated) return;
        if (!text) {
            bucks.tabs.stopFind(tab.id, "clearSelection").catch(() => {});
            total = null;
            active = 0;
            return;
        }
        bucks.tabs.find(tab.id, text, { matchCase, ...opts }).catch(() => {});
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.key === "Enter") {
            e.preventDefault();
            search({ findNext: true, forward: !e.shiftKey });
        }
    }

    // Results for the tab we searched in.
    $effect(() =>
        bucks.tabs.onFoundInPage((r) => {
            if (r.id !== tabId) return;
            total = r.matches;
            active = r.activeMatchOrdinal;
        }),
    );

    // Focus the field on every Ctrl+F; leave the selection on the match when the bar closes.
    $effect(() => {
        void $findBarFocus;
        if (!$findBarOpen) return;
        tabId = $activeTab?.id ?? "";
        void tick().then(() => inputEl?.select());
        return () => {
            if (tabId) bucks.tabs.stopFind(tabId, "keepSelection").catch(() => {});
            total = null;
            active = 0;
        };
    });

    // Switching to another tab (or to an internal page) closes the bar.
    $effect(() => {
        const tab = $activeTab;
        if ($findBarOpen && (tab?.id !== tabId || tab?.type !== "external")) close();
    });
</script>

{#if $findBarOpen}
    <div
        class="fixed top-[100px] right-6 z-find-bar flex items-center gap-1 h-9 pl-3 pr-1 rounded-xl bg-surface-raised/95 border border-line-strong shadow-xl backdrop-blur-xl"
        role="search"
    >
        <input
            bind:this={inputEl}
            bind:value={text}
            oninput={() => search()}
            onkeydown={onKeydown}
            placeholder="Find in page"
            aria-label="Find in page"
            spellcheck="false"
            class="w-52 bg-transparent text-xs text-fg-muted placeholder-fg-faint outline-none"
        />
        <span class="min-w-[52px] text-right text-3xs font-mono {total === 0 ? 'text-danger-fg-strong/80' : 'text-fg-faint'}">
            {#if total !== null && text}{total === 0 ? "no match" : `${active}/${total}`}{/if}
        </span>
        <button
            onclick={() => { matchCase = !matchCase; search(); }}
            title="Match case"
            aria-pressed={matchCase}
            class="w-7 h-7 flex items-center justify-center rounded-lg transition-colors {matchCase ? 'bg-accent/20 text-accent-fg-strong' : 'text-fg-faint hover:text-fg hover:bg-surface-4'}"
        ><CaseSensitive size={14} /></button>
        <button onclick={() => search({ findNext: true, forward: false })} title="Previous match (Shift+Enter)" aria-label="Previous match"
            class="w-7 h-7 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg hover:bg-surface-4"><ChevronUp size={14} /></button>
        <button onclick={() => search({ findNext: true, forward: true })} title="Next match (Enter)" aria-label="Next match"
            class="w-7 h-7 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg hover:bg-surface-4"><ChevronDown size={14} /></button>
        <button onclick={close} title="Close (Esc)" aria-label="Close find bar"
            class="w-7 h-7 flex items-center justify-center rounded-lg text-fg-faint hover:text-fg hover:bg-surface-4"><X size={13} /></button>
    </div>
{/if}
