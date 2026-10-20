<script lang="ts">
    // Your Spaces and how many tabs each holds; click one to switch to it.
    import { browserStore } from "$lib/stores";
    import type { Widget } from "../board";

    // Same props as every widget; this one has no settings.
    let _props: { widget?: Widget } = $props();
    import { tabColorClass } from "$lib/tabColors";

    const spaces = $derived(
        $browserStore.spaces.map((s) => ({ ...s, count: $browserStore.tabs.filter((t) => (t.spaceId ?? "default") === s.id && !t.private).length })),
    );
</script>

<div class="space-y-1">
    {#each spaces as s (s.id)}
        <button onclick={() => browserStore.switchSpace(s.id)}
            class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-surface-2 transition-colors {s.id === $browserStore.activeSpaceId ? 'bg-surface-2' : ''}">
            <span class="w-2 h-2 rounded-full {tabColorClass(s.color)}"></span>
            <span class="text-xs text-fg-muted truncate">{s.name}</span>
            <span class="ml-auto text-2xs text-fg-faint tabular-nums">{s.count} tab{s.count === 1 ? "" : "s"}</span>
        </button>
    {/each}
</div>
