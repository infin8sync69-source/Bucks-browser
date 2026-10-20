<script lang="ts">
    import { onMount } from 'svelte';
    import { TriangleAlert, RotateCw } from 'lucide-svelte';
    import { bucks } from './bridge';
    import { activeTab, browserStore } from './stores';
    import { chatOpen, overlayCount, findBarOpen } from './uiState';

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
        void $findBarOpen;
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
    class="fixed bottom-dock left-0 z-base transition-[right] duration-moderate ease-out {$findBarOpen ? 'top-chrome-top-find' : 'top-chrome-top'} {$chatOpen ? 'right-chat-panel' : 'right-0'}"
    style:visibility={isExternal ? 'visible' : 'hidden'}
>
    {#if showError && error}
        <div class="w-full h-full flex items-center justify-center bg-canvas px-6">
            <div class="max-w-md w-full text-center space-y-4">
                <div class="mx-auto w-14 h-14 rounded-2xl bg-danger/10 border border-danger/20 flex items-center justify-center">
                    <TriangleAlert size={26} class="text-danger-fg" />
                </div>
                <div class="space-y-1.5">
                    <h2 class="text-lg font-semibold text-fg">This page can't be reached</h2>
                    <p class="text-md text-fg-subtle">{error.description || 'The page failed to load.'}</p>
                    {#if error.code}
                        <p class="text-2xs text-fg-faint font-mono">Error {error.code}</p>
                    {/if}
                </div>
                <p class="text-xs font-mono text-fg-faint break-all bg-surface-1 border border-line-subtle rounded-xl px-3 py-2">
                    {error.url || $activeTab?.url}
                </p>
                <button
                    onclick={() => browserStore.refresh()}
                    class="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-surface-4 hover:bg-surface-5 text-md text-fg transition-colors"
                >
                    <RotateCw size={14} /> Retry
                </button>
            </div>
        </div>
    {/if}
</div>
