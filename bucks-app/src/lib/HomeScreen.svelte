<script lang="ts">
    import { scale, fade } from 'svelte/transition';
    import { elasticOut, cubicOut } from 'svelte/easing';
    import { X } from 'lucide-svelte';
    import AppIcon from './AppIcon.svelte';
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

    function getCell(row: number, col: number): MiniApp | null {
        const id = layout[`${row},${col}`];
        return id ? (getApp(id) ?? null) : null;
    }

    // ── Edit mode ────────────────────────────────────────────────────────────
    let editMode = $state(false);
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

<!-- Home screen — fills the available area below Header + above AgenticBar -->
<div
    class="absolute inset-0 flex flex-col items-center justify-center"
    onclick={handleBackdropClick}
    role="presentation"
>
    <!-- App grid -->
    <div class="relative grid gap-3 p-6" style="grid-template-columns: repeat({GRID_COLS}, 80px); grid-template-rows: repeat({GRID_ROWS}, 90px);">

        {#each Array.from({ length: GRID_ROWS }) as _, row}
            {#each Array.from({ length: GRID_COLS }) as _, col}
                {@const app = getCell(row, col)}
                {@const key  = `${row},${col}`}
                {@const isHover = hoveredCell === key}
                {@const isDragging = $dragState.active && $dragState.fromRow === row && $dragState.fromCol === col}

                <!-- Drop zone + tile wrapper -->
                <div
                    class="relative w-20 h-[90px] flex flex-col items-center justify-start gap-1.5
                           rounded-2xl transition-all duration-200
                           {isHover && $dragState.active
                             ? 'ring-2 ring-violet-400/60 bg-violet-500/10 scale-105'
                             : 'ring-1 ring-white/[0.04]'}"
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
                            in:scale={{ duration: 350, easing: elasticOut, start: 0.7 }}
                            class="relative w-16 h-16 rounded-[18px] flex items-center justify-center cursor-pointer
                                   select-none transition-transform duration-150 active:scale-90
                                   {isDragging ? 'opacity-40 scale-95' : 'opacity-100'}
                                   {editMode ? 'animate-wiggle' : ''}"
                            style="background: linear-gradient(135deg, {app.gradient[0]}, {app.gradient[1]});
                                   box-shadow: 0 8px 24px -4px {app.glow}, 0 2px 8px rgba(0,0,0,0.4);"
                            role="button"
                            tabindex="0"
                        >
                            <!-- Glossy overlay -->
                            <div class="absolute inset-0 rounded-[18px] bg-gradient-to-b from-white/20 to-transparent pointer-events-none"></div>

                            <!-- Icon -->
                            <span class="z-10 drop-shadow-sm">
                                <AppIcon name={app.icon} size={26} color="white" strokeWidth={1.6} />
                            </span>

                            <!-- Badge -->
                            {#if app.badge}
                                <div class="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-red-500 flex items-center justify-center px-1">
                                    <span class="text-[9px] text-white font-bold">{app.badge}</span>
                                </div>
                            {/if}

                            <!-- Edit mode remove button -->
                            {#if editMode && !app.isBuiltIn}
                                <button
                                    onclick={(e) => { e.stopPropagation(); removeApp(app.id); }}
                                    transition:scale={{ duration: 200, start: 0 }}
                                    class="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-[#1a1a24] border border-white/20
                                           flex items-center justify-center text-white/70 hover:text-white shadow-lg z-20"
                                >
                                    <X size={10} />
                                </button>
                            {/if}
                        </div>

                        <!-- App label -->
                        <span class="text-[10px] text-white/65 font-medium tracking-tight text-center leading-tight max-w-[72px] truncate select-none">
                            {app.name}
                        </span>

                    {:else}
                        <!-- Empty cell — faint dotted border when dragging -->
                        <div class="w-16 h-16 rounded-[18px] transition-all duration-200
                                    {$dragState.active
                                      ? 'border-2 border-dashed border-white/15 bg-white/[0.02]'
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
            class="absolute bottom-28 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5
                   bg-[#0d0d12]/90 backdrop-blur-xl border border-white/[0.08] rounded-2xl shadow-2xl"
            transition:fade={{ duration: 200 }}
        >
            <span class="text-[11px] text-white/50">Hold to drag · tap ✕ to remove</span>
            <div class="h-4 w-[1px] bg-white/10"></div>
            <button
                onclick={() => { homeStore.reset(); editMode = false; }}
                class="text-[11px] text-white/40 hover:text-rose-400 transition-colors"
            >Reset</button>
            <button
                onclick={() => editMode = false}
                class="text-[11px] text-white/70 hover:text-white font-semibold transition-colors"
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
        animation: wiggle 0.35s ease-in-out infinite;
    }
</style>
