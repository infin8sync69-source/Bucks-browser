<script lang="ts">
    import { onMount } from 'svelte';
    import { TriangleAlert, RotateCw } from 'lucide-svelte';
    import { bucks } from './bridge';
    import { activeTab, browserStore } from './stores';
    import { chatOpen, overlayCount } from './uiState';

    /**
     * Placeholder for the active external tab's web view. The page itself is a WebContentsView
     * owned by the main process; this element only reports where it should be drawn
     * (see "Content rectangle protocol" in docs/IPC-CONTRACT.md).
     */
    let el = $state<HTMLDivElement | null>(null);

    const isExternal = $derived($activeTab?.type === 'external');
    const error = $derived(isExternal ? ($activeTab?.error ?? null) : null);
    const showError = $derived(error !== null);

    let lastBounds = '';
    function reportBounds() {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const bounds = {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
        };
        const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
        if (key === lastBounds) return;
        lastBounds = key;
        bucks.tabs.setContentBounds(bounds).catch((e) => console.warn('[content] setContentBounds failed:', e));
    }

    onMount(() => {
        if (!el) return;
        const observer = new ResizeObserver(reportBounds);
        observer.observe(el);
        window.addEventListener('resize', reportBounds);
        reportBounds();
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', reportBounds);
        };
    });

    // The chat drawer changes the placeholder's right edge (via CSS transition); re-measure after
    // the layout class flips and again once the transition has finished.
    $effect(() => {
        void $chatOpen;
        void isExternal;
        const raf = requestAnimationFrame(reportBounds);
        const settle = setTimeout(reportBounds, 350);
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(settle);
        };
    });

    // Chrome overlays and the error panel must be drawn over the page, so the native view is hidden.
    let lastVisible: boolean | null = null;
    $effect(() => {
        const visible = $overlayCount === 0 && !showError;
        if (visible === lastVisible) return;
        lastVisible = visible;
        bucks.tabs.setContentVisible(visible).catch((e) => console.warn('[content] setContentVisible failed:', e));
    });
</script>

<div
    bind:this={el}
    data-content-area
    class="fixed top-24 bottom-[88px] left-0 z-0 transition-[right] duration-300 ease-out {$chatOpen ? 'right-[448px]' : 'right-0'}"
    style:visibility={isExternal ? 'visible' : 'hidden'}
>
    {#if showError && error}
        <div class="w-full h-full flex items-center justify-center bg-[#07070a] px-6">
            <div class="max-w-md w-full text-center space-y-4">
                <div class="mx-auto w-14 h-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                    <TriangleAlert size={26} class="text-red-400" />
                </div>
                <div class="space-y-1.5">
                    <h2 class="text-lg font-semibold text-white">This page can't be reached</h2>
                    <p class="text-sm text-white/60">{error.description || 'The page failed to load.'}</p>
                    {#if error.code}
                        <p class="text-[11px] text-white/25 font-mono">Error {error.code}</p>
                    {/if}
                </div>
                <p class="text-xs font-mono text-white/40 break-all bg-white/[0.03] border border-white/5 rounded-xl px-3 py-2">
                    {error.url || $activeTab?.url}
                </p>
                <button
                    onclick={() => browserStore.refresh()}
                    class="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-sm text-white transition-colors"
                >
                    <RotateCw size={14} /> Retry
                </button>
            </div>
        </div>
    {/if}
</div>
