<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    // The widget board under the app grid: cards in a responsive grid. Drag a card by its title to
    // move it, or use the arrows; Add widget opens the library.
    import { flip } from "svelte/animate";
    import { fade, scale } from "svelte/transition";
    import { ChevronLeft, ChevronRight, X, Plus, Clock, CloudSun, CalendarDays, StickyNote, Music, Layers } from "lucide-svelte";
    import { WIDGET_LIBRARY, MAX_WIDGETS, type WidgetType } from "./board";
    import { boardStore } from "./stores";
    import ClockWidget from "./widgets/ClockWidget.svelte";
    import WeatherWidget from "./widgets/WeatherWidget.svelte";
    import TodayWidget from "./widgets/TodayWidget.svelte";
    import NotesWidget from "./widgets/NotesWidget.svelte";
    import NowPlayingWidget from "./widgets/NowPlayingWidget.svelte";
    import SpacesWidget from "./widgets/SpacesWidget.svelte";

    const ICONS = { clock: Clock, weather: CloudSun, today: CalendarDays, notes: StickyNote, "now-playing": Music, spaces: Layers } as const;
    const VIEWS = { clock: ClockWidget, weather: WeatherWidget, today: TodayWidget, notes: NotesWidget, "now-playing": NowPlayingWidget, spaces: SpacesWidget } as const;
    const info = (t: WidgetType) => WIDGET_LIBRARY.find((w) => w.type === t)!;

    let libraryOpen = $state(false);
    let dragUid = $state<string | null>(null);
    let overIndex = $state<number | null>(null);
    const widgets = $derived($boardStore.widgets);

    function drop(index: number) {
        if (dragUid) boardStore.move(dragUid, index);
        dragUid = null;
        overIndex = null;
    }

    function add(type: WidgetType) {
        boardStore.add(type);
        libraryOpen = false;
    }

    $effect(() => {
        if (!libraryOpen) return;
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && (libraryOpen = false);
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });
</script>

<section class="w-full" aria-label="Widgets">
    <div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));">
        {#each widgets as w, i (w.uid)}
            {@const Icon = ICONS[w.type]}
            {@const View = VIEWS[w.type]}
            <article
                animate:flip={{ duration: motion.base }}
                class="group relative rounded-2xl border bg-surface-1 p-4 transition-colors
                       {overIndex === i && dragUid && dragUid !== w.uid ? 'border-agent/50' : 'border-line'}
                       {dragUid === w.uid ? 'opacity-40' : ''}"
                aria-label={info(w.type).name}
                ondragover={(e) => { if (dragUid) { e.preventDefault(); overIndex = i; } }}
                ondragleave={() => (overIndex = null)}
                ondrop={(e) => { e.preventDefault(); drop(i); }}
            >
                <!-- Dragging is the mouse shortcut; the arrow buttons do the same from the keyboard. -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <header class="flex items-center gap-2 mb-3 cursor-grab active:cursor-grabbing" draggable="true"
                    ondragstart={(e) => { dragUid = w.uid; e.dataTransfer?.setData("text/plain", w.uid); if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }}
                    ondragend={() => { dragUid = null; overIndex = null; }}>
                    <Icon size={12} class="text-fg-faint" />
                    <h3 class="text-2xs uppercase tracking-wider text-fg-faint">{info(w.type).name}</h3>
                    <div class="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <button onclick={() => boardStore.move(w.uid, i - 1)} disabled={i === 0} title="Move left" aria-label="Move {info(w.type).name} left"
                            class="w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-fg hover:bg-surface-4 disabled:opacity-20"><ChevronLeft size={12} /></button>
                        <button onclick={() => boardStore.move(w.uid, i + 1)} disabled={i === widgets.length - 1} title="Move right" aria-label="Move {info(w.type).name} right"
                            class="w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-fg hover:bg-surface-4 disabled:opacity-20"><ChevronRight size={12} /></button>
                        <button onclick={() => boardStore.remove(w.uid)} title="Remove widget" aria-label="Remove {info(w.type).name}"
                            class="w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-fg hover:bg-surface-4"><X size={12} /></button>
                    </div>
                </header>
                <View widget={w} />
            </article>
        {/each}
        {#if widgets.length < MAX_WIDGETS}
            <button onclick={() => (libraryOpen = true)}
                class="min-h-[120px] rounded-2xl border border-dashed border-line-strong hover:border-line-emphasis hover:bg-surface-1 flex flex-col items-center justify-center gap-1.5 text-fg-faint hover:text-fg-muted transition-colors">
                <Plus size={18} />
                <span class="text-xs">Add widget</span>
            </button>
        {/if}
    </div>
</section>

{#if libraryOpen}
    <div class="fixed inset-0 z-menu-backdrop flex items-center justify-center bg-scrim/50 backdrop-blur-sm p-6" transition:fade={{ duration: motion.fast }}
        role="presentation" onclick={() => (libraryOpen = false)}>
        <div class="w-full max-w-lg rounded-3xl border border-line-strong bg-surface-raised p-6 shadow-2xl" role="dialog" aria-modal="true" aria-label="Widget library" tabindex="-1"
            onclick={(e) => e.stopPropagation()} onkeydown={() => {}} transition:scale={{ duration: motion.fast, start: 0.97 }}>
            <div class="flex items-center mb-4">
                <h2 class="text-lg text-fg">Widget library</h2>
                <button onclick={() => (libraryOpen = false)} aria-label="Close" class="ml-auto w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-4 text-fg-faint"><X size={15} /></button>
            </div>
            <div class="space-y-2">
                {#each WIDGET_LIBRARY as w (w.type)}
                    {@const Icon = ICONS[w.type]}
                    <div class="flex items-center gap-3 rounded-2xl bg-surface-1 border border-line p-3">
                        <span class="w-9 h-9 flex items-center justify-center rounded-xl bg-surface-2 text-fg-subtle"><Icon size={16} /></span>
                        <div class="min-w-0 flex-1">
                            <p class="text-sm text-fg-muted">{w.name}</p>
                            <p class="text-2xs text-fg-faint">{w.description}</p>
                        </div>
                        <button onclick={() => add(w.type)} class="px-3 py-1.5 rounded-xl bg-fg text-fg-inverse text-xs font-medium hover:bg-fg/90">Add</button>
                    </div>
                {/each}
            </div>
        </div>
    </div>
{/if}
