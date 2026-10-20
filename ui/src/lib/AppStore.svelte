<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    import { fade, fly, scale } from 'svelte/transition';
    import { cubicOut, quintOut } from 'svelte/easing';
    import { X, Plus, Check, Grip } from 'lucide-svelte';
    import AppIcon from './AppIcon.svelte';
    import { toneVars } from './tones';
    import {
        APP_REGISTRY, CATEGORIES, appsByCategory, homeStore, dragState,
        type MiniApp, type Category
    } from './homeStore';
    import { get } from 'svelte/store';
    import { onMount } from 'svelte';
    import { pushOverlay, popOverlay } from './uiState';

    let { onclose = () => {} }: { onclose?: () => void } = $props();

    // Full-screen overlay: hide the native web view while the store is open.
    onMount(() => {
        pushOverlay();
        return popOverlay;
    });

    // ── Scroll state for parallax ─────────────────────────────────────────────
    let scrollEl: HTMLDivElement;
    let scrollY   = $state(0);
    let activeCategory = $state<Category | null>(null);

    function onScroll() {
        if (!scrollEl) return;
        scrollY = scrollEl.scrollTop;
    }

    // ── Keyboard ──────────────────────────────────────────────────────────────
    function handleKey(e: KeyboardEvent) {
        if (e.key === 'Escape') onclose();
    }

    // ── Install / drag ─────────────────────────────────────────────────────────
    let installed = $derived($homeStore);

    function isInstalled(appId: string) {
        return Object.values(installed).includes(appId);
    }

    function addApp(app: MiniApp) {
        homeStore.addToFirstEmpty(app.id);
        // brief visual feedback — handled by reactive isInstalled
    }

    function startDrag(e: DragEvent, app: MiniApp) {
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/plain', app.id);
        dragState.set({ active: true, appId: app.id, fromRow: null, fromCol: null, source: 'store' });
    }

    function endDrag() {
        dragState.set({ active: false, appId: null, fromRow: null, fromCol: null, source: null });
        onclose();
    }

    // ── Parallax helper ───────────────────────────────────────────────────────
    function parallax(depth: number) {
        return `transform: translateY(${scrollY * depth * -0.12}px)`;
    }
</script>

<svelte:window onkeydown={handleKey} />

<!-- Full-screen backdrop -->
<div
    class="fixed inset-0 z-sheet-backdrop bg-scrim/60 backdrop-blur-md"
    transition:fade={{ duration: motion.base }}
    onclick={onclose}
    role="presentation"
></div>

<!-- Store panel — slides in from top -->
<div
    class="fixed inset-0 z-sheet flex flex-col overflow-hidden"
    transition:fly={{ y: -30, duration: motion.moderate, easing: cubicOut }}
>
    <!-- ── Sticky header ─────────────────────────────────────────────────── -->
    <div class="relative z-raised flex items-center gap-4 px-8 pt-22 pb-4 bg-gradient-to-b from-canvas-deep via-canvas-deep/95 to-transparent pointer-events-auto">
        <!-- Title -->
        <div class="flex-1">
            <h1 class="text-2xl font-bold text-fg tracking-tight">App Store</h1>
            <p class="text-2xs text-fg-faint mt-0.5 tracking-wide">Web3 Super-App Ecosystem · {APP_REGISTRY.length} apps</p>
        </div>

        <!-- Category pills -->
        <div class="hidden md:flex items-center gap-1.5 bg-surface-2 border border-line rounded-2xl px-2 py-1.5">
            {#each CATEGORIES as cat}
                <button
                    onclick={() => {
                        activeCategory = activeCategory === cat.id ? null : cat.id;
                        // scroll to section
                        const el = document.getElementById(`cat-${cat.id}`);
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    class="px-3 py-1 rounded-xl text-2xs font-semibold transition-all duration-base
                           {activeCategory === cat.id
                             ? 'bg-surface-4 text-fg'
                             : 'text-fg-faint hover:text-fg-muted'}"
                >
                    {cat.emoji} {cat.label}
                </button>
            {/each}
        </div>

        <button
            onclick={onclose}
            class="w-9 h-9 rounded-xl flex items-center justify-center bg-surface-2 hover:bg-surface-4 text-fg-faint hover:text-fg transition-all border border-line"
        >
            <X size={16} />
        </button>
    </div>

    <!-- ── Scrollable content ─────────────────────────────────────────────── -->
    <div
        bind:this={scrollEl}
        onscroll={onScroll}
        class="flex-1 overflow-y-auto overflow-x-hidden pb-32 pointer-events-auto"
        style="scrollbar-width:none;"
    >
        <!-- ── Hero section ──────────────────────────────────────────────── -->
        <div class="relative h-[260px] flex flex-col items-center justify-center overflow-hidden select-none">
            <!-- Parallax aurora layers -->
            <div
                class="absolute inset-0 pointer-events-none"
                style="{parallax(2)}"
            >
                <div class="absolute top-[-20%] left-[10%] w-[500px] h-[500px] rounded-full blur-4xl opacity-15"
                     style="background: radial-gradient(circle, var(--bucks-color-cat-violet-strong), transparent 70%)"></div>
                <div class="absolute top-[10%] right-[5%] w-[400px] h-[400px] rounded-full blur-4xl opacity-10"
                     style="background: radial-gradient(circle, var(--bucks-color-cat-cyan-strong), transparent 70%)"></div>
            </div>
            <div
                class="absolute inset-0 pointer-events-none"
                style="{parallax(1)}"
            >
                <div class="absolute bottom-[-10%] left-[40%] w-[350px] h-[350px] rounded-full blur-4xl opacity-12"
                     style="background: radial-gradient(circle, var(--bucks-color-cat-pink-strong), transparent 70%)"></div>
            </div>

            <!-- Hero text -->
            <div class="relative z-raised text-center" style="{parallax(0.5)}">
                <p class="text-5xl font-black text-fg tracking-display leading-none lowercase">
                    bucks
                    <span class="bg-gradient-to-r from-agent via-cat-cyan to-agent bg-clip-text text-transparent">
                        store
                    </span>
                </p>
                <p class="text-sm text-fg-faint mt-3 tracking-caps uppercase font-medium">
                    Drag apps to your home screen
                </p>
                <!-- Drag hint animation -->
                <div class="flex items-center justify-center gap-2 mt-4 text-2xs text-fg-disabled">
                    <Grip size={12} />
                    <span>Drag any card below · or click + to add</span>
                </div>
            </div>
        </div>

        <!-- ── Category sections ─────────────────────────────────────────── -->
        {#each CATEGORIES as cat, catIdx}
            {@const apps = appsByCategory(cat.id)}
            <section
                id="cat-{cat.id}"
                class="px-8 mb-16"
                style="{parallax(catIdx * 0.4)}"
            >
                <!-- Section header -->
                <div class="flex items-end gap-3 mb-6">
                    <div
                        class="w-10 h-10 rounded-2xl flex items-center justify-center text-xl"
                        style="{toneVars(cat.tone, { tint: 19 })} background: linear-gradient(135deg, var(--tone-tint), color-mix(in srgb, var(--tone) 6%, transparent)); border: 1px solid color-mix(in srgb, var(--tone) 15%, transparent);"
                    >
                        {cat.emoji}
                    </div>
                    <div>
                        <h2 class="text-xl font-bold text-fg tracking-tight leading-none">{cat.label}</h2>
                        <p class="text-2xs text-fg-faint mt-0.5">{apps.length} apps</p>
                    </div>
                    <div class="flex-1 h-[1px] bg-gradient-to-r from-surface-4 to-transparent ml-4 mb-2"></div>
                </div>

                <!-- App card grid — horizontal scroll on narrow, wrap on wide -->
                <div class="flex gap-4 overflow-x-auto pb-2" style="scrollbar-width:none;">
                    {#each apps as app, i}
                        {@const installed = isInstalled(app.id)}
                        <div
                            role="group"
                            aria-label={app.name}
                            draggable="true"
                            ondragstart={(e) => startDrag(e, app)}
                            ondragend={endDrag}
                            in:fly={{ y: 20, duration: motion.moderate, delay: i * 50, easing: quintOut }}
                            class="relative flex-shrink-0 w-44 group/card cursor-grab active:cursor-grabbing"
                        >
                            <!-- Card -->
                            <div class="relative rounded-2xl overflow-hidden border transition-all duration-moderate
                                        bg-surface-1 border-line
                                        hover:border-line-emphasis hover:bg-surface-3
                                        hover:shadow-glow
                                        hover:-translate-y-1"
                                 style={toneVars(app.tone)}>

                                <!-- Gradient top band -->
                                <div class="h-24 relative overflow-hidden"
                                     style="background: linear-gradient(135deg, var(--tone-strong), var(--tone-deep));">
                                    <!-- Shimmer -->
                                    <div class="absolute inset-0 bg-gradient-to-br from-surface-4 to-transparent"></div>
                                    <!-- Glow circles -->
                                    <div class="absolute -top-4 -right-4 w-20 h-20 rounded-full blur-xl opacity-30"
                                         style="background: var(--tone-strong);"></div>
                                    <!-- Icon -->
                                    <div class="absolute inset-0 flex items-center justify-center">
                                        <span class="drop-shadow-lg">
                                            <AppIcon name={app.icon} size={38} class="text-on-emphasis" strokeWidth={1.5} />
                                        </span>
                                    </div>
                                    <!-- Drag handle -->
                                    <div class="absolute top-2 left-2 opacity-0 group-hover/card:opacity-60 transition-opacity">
                                        <Grip size={12} class="text-fg" />
                                    </div>
                                    <!-- Installed badge -->
                                    {#if installed}
                                        <div class="absolute top-2 right-2 w-5 h-5 rounded-full bg-success-emphasis text-on-emphasis flex items-center justify-center" transition:scale={{ duration: motion.base }}>
                                            <Check size={10} />
                                        </div>
                                    {/if}
                                </div>

                                <!-- Card body -->
                                <div class="p-3">
                                    <p class="text-sm font-semibold text-fg leading-none">{app.name}</p>
                                    <p class="text-3xs text-fg-faint mt-1.5 leading-relaxed line-clamp-2">{app.description}</p>

                                    <!-- Add button -->
                                    <button
                                        onclick={(e) => { e.stopPropagation(); addApp(app); }}
                                        class="mt-3 w-full rounded-xl py-1.5 text-2xs font-semibold transition-all duration-base
                                               {installed
                                                 ? 'bg-success/10 text-success-fg border border-success/20'
                                                 : 'bg-surface-3 hover:bg-surface-4 text-fg-subtle hover:text-fg border border-line hover:border-line-emphasis'}"
                                    >
                                        {#if installed}
                                            <span class="flex items-center justify-center gap-1"><Check size={10} />Added</span>
                                        {:else}
                                            <span class="flex items-center justify-center gap-1"><Plus size={10} />Add</span>
                                        {/if}
                                    </button>
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
            </section>
        {/each}

        <!-- Bottom spacer -->
        <div class="h-20"></div>
    </div>

    <!-- ── Bottom gradient fade ───────────────────────────────────────────── -->
    <div class="absolute bottom-0 inset-x-0 h-20 pointer-events-none"
         style="background: linear-gradient(to top, var(--bucks-color-canvas-deep), transparent)"></div>
</div>

<style>
    :global(section) { pointer-events: auto; }
    div::-webkit-scrollbar { display: none; }
</style>
