<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    import { scale, fade } from 'svelte/transition';
    import { elasticOut, cubicOut } from 'svelte/easing';
    import { X } from 'lucide-svelte';
    import AppIcon from './AppIcon.svelte';
    import { toneVars } from './tones';
    import {
        homeStore, dragState, getApp,
        GRID_COLS, GRID_ROWS,
        type MiniApp,
    } from './homeStore';
    import { browserStore } from './stores';
    import { swarmStore } from './swarmStore';

    let { onOpenStore = () => {} }: { onOpenStore?: () => void } = $props();

    // ── Derived grid ─────────────────────────────────────────────────────────
    let layout = $derived($homeStore);

    // Only the rows in use are shown; all of them while arranging or dragging.
    let lastUsedRow = $derived(
        Object.keys(layout).reduce((max, k) => (layout[k] ? Math.max(max, Number(k.split(',')[0])) : max), -1),
    );

    function getCell(row: number, col: number): MiniApp | null {
        const id = layout[`${row},${col}`];
        return id ? (getApp(id) ?? null) : null;
    }

    // ── Edit mode ────────────────────────────────────────────────────────────
    let editMode = $state(false);
    let visibleRows = $derived(editMode || $dragState.active ? GRID_ROWS : Math.min(GRID_ROWS, Math.max(1, lastUsedRow + 1)));
    let longPressTimer: ReturnType<typeof setTimeout>;

    function startLongPress(row: number, col: number) {
        longPressTimer = setTimeout(() => { editMode = true; }, 500);
    }
    function cancelLongPress() { clearTimeout(longPressTimer); }

    // ── Tap to launch ─────────────────────────────────────────────────────────
    function launchApp(app: MiniApp) {
        if (editMode) return;
        if (app.href) {
            browserStore.createTab(app.href);
        } else if (app.action === 'open_agent') {
            swarmStore.sendQuery('Hello, I need your help.');
        }
    }

    // ── Drag from grid ────────────────────────────────────────────────────────
    function onDragStart(e: DragEvent, app: MiniApp, row: number, col: number) {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', app.id);
        dragState.set({ active: true, appId: app.id, fromRow: row, fromCol: col, source: 'grid' });
    }

    function onDragEnd() {
        dragState.set({ active: false, appId: null, fromRow: null, fromCol: null, source: null });
    }

    // ── Drop onto cell ────────────────────────────────────────────────────────
    let hoveredCell = $state<string | null>(null);

    function onDragOver(e: DragEvent, row: number, col: number) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = $dragState.source === 'store' ? 'copy' : 'move';
        hoveredCell = `${row},${col}`;
    }

    function onDragLeave() { hoveredCell = null; }

    function onDrop(e: DragEvent, row: number, col: number) {
        e.preventDefault();
        hoveredCell = null;
        const ds = $dragState;
        if (!ds.appId) return;

        if (ds.source === 'store') {
            homeStore.placeApp(row, col, ds.appId);
        } else if (ds.source === 'grid' && ds.fromRow !== null && ds.fromCol !== null) {
            homeStore.swapApps(ds.fromRow, ds.fromCol, row, col);
        }
        dragState.set({ active: false, appId: null, fromRow: null, fromCol: null, source: null });
    }

    // ── Remove app ────────────────────────────────────────────────────────────
    function removeApp(appId: string) { homeStore.removeApp(appId); }

    // Close edit mode on click outside
    function handleBackdropClick() { if (editMode) editMode = false; }
</script>

<!-- Home screen app grid — part of the new-tab dashboard column -->
<div
    class="relative flex flex-col items-center"
    onclick={handleBackdropClick}
    role="presentation"
>
    <!-- App grid -->
    <div class="relative grid gap-3 p-6" style="grid-template-columns: repeat({GRID_COLS}, 80px); grid-template-rows: repeat({visibleRows}, 90px);">

        {#each Array.from({ length: visibleRows }) as _, row}
            {#each Array.from({ length: GRID_COLS }) as _, col}
                {@const app = getCell(row, col)}
                {@const key  = `${row},${col}`}
                {@const isHover = hoveredCell === key}
                {@const isDragging = $dragState.active && $dragState.fromRow === row && $dragState.fromCol === col}

                <!-- Drop zone + tile wrapper -->
                <div
                    class="relative w-20 h-[90px] flex flex-col items-center justify-start gap-1.5
                           rounded-2xl transition-all duration-base
                           {isHover && $dragState.active
                             ? 'ring-2 ring-agent/60 bg-agent/10 scale-105'
                             : 'ring-1 ring-line-subtle'}"
                    ondragover={(e) => onDragOver(e, row, col)}
                    ondragleave={onDragLeave}
                    ondrop={(e) => onDrop(e, row, col)}
                    role="button"
                    tabindex={app ? 0 : -1}
                    aria-label={app ? `${app.name} app` : 'empty slot'}
                >
                    {#if app}
                        <!-- App icon tile -->
                        <div
                            draggable="true"
                            ondragstart={(e) => onDragStart(e, app, row, col)}
                            ondragend={onDragEnd}
                            onpointerdown={() => startLongPress(row, col)}
                            onpointerup={cancelLongPress}
                            onpointerleave={cancelLongPress}
                            onclick={() => launchApp(app)}
                            onkeydown={(e) => e.key === 'Enter' && launchApp(app)}
                            in:scale={{ duration: motion.moderate, easing: elasticOut, start: 0.7 }}
                            class="relative w-16 h-16 rounded-2xl flex items-center justify-center cursor-pointer
                                   select-none transition-transform duration-fast active:scale-90
                                   {isDragging ? 'opacity-40 scale-95' : 'opacity-100'}
                                   shadow-app-icon {editMode ? 'animate-wiggle' : ''}"
                            style="{toneVars(app.tone)} background: linear-gradient(135deg, var(--tone-strong), var(--tone-deep));"
                            role="button"
                            tabindex="0"
                        >
                            <!-- Glossy overlay -->
                            <div class="absolute inset-0 rounded-2xl bg-gradient-to-b from-surface-5 to-transparent pointer-events-none"></div>

                            <!-- Icon -->
                            <span class="z-raised drop-shadow-sm">
                                <AppIcon name={app.icon} size={26} class="text-on-emphasis" strokeWidth={1.6} />
                            </span>

                            <!-- Badge -->
                            {#if app.badge}
                                <div class="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-danger-emphasis flex items-center justify-center px-1">
                                    <span class="text-3xs text-on-emphasis font-bold">{app.badge}</span>
                                </div>
                            {/if}

                            <!-- Edit mode remove button -->
                            {#if editMode && !app.isBuiltIn}
                                <button
                                    onclick={(e) => { e.stopPropagation(); removeApp(app.id); }}
                                    transition:scale={{ duration: motion.base, start: 0 }}
                                    class="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-surface-overlay border border-line-emphasis
                                           flex items-center justify-center text-fg-muted hover:text-fg shadow-lg z-float"
                                >
                                    <X size={10} />
                                </button>
                            {/if}
                        </div>

                        <!-- App label -->
                        <span class="text-3xs text-fg-subtle font-medium tracking-tight text-center leading-tight max-w-[72px] truncate select-none">
                            {app.name}
                        </span>

                    {:else}
                        <!-- Empty cell — faint dotted border when dragging -->
                        <div class="w-16 h-16 rounded-2xl transition-all duration-base
                                    {$dragState.active
                                      ? 'border-2 border-dashed border-line-emphasis bg-surface-1'
                                      : 'border border-transparent'}">
                        </div>
                    {/if}
                </div>
            {/each}
        {/each}
    </div>

    <!-- ── Edit mode toolbar ──────────────────────────────────────────────── -->
    {#if editMode}
        <div
            class="fixed bottom-28 left-1/2 -translate-x-1/2 z-float flex items-center gap-3 px-4 py-2.5
                   bg-surface-raised/90 backdrop-blur-xl border border-line rounded-2xl shadow-2xl"
            transition:fade={{ duration: motion.base }}
        >
            <span class="text-2xs text-fg-faint">Hold to drag · tap ✕ to remove</span>
            <div class="h-4 w-[1px] bg-surface-4"></div>
            <button
                onclick={() => { homeStore.reset(); editMode = false; }}
                class="text-2xs text-fg-faint hover:text-cat-rose-fg transition-colors"
            >Reset</button>
            <button
                onclick={() => editMode = false}
                class="text-2xs text-fg-muted hover:text-fg font-semibold transition-colors"
            >Done</button>
        </div>
    {/if}
</div>

<style>
    @keyframes wiggle {
        0%,100% { transform: rotate(-1.5deg); }
        50%      { transform: rotate(1.5deg); }
    }
    .animate-wiggle {
        animation: wiggle var(--bucks-duration-moderate) var(--bucks-easing-in-out) infinite;
    }
</style>
