<script lang="ts">
    import { onMount, createEventDispatcher } from "svelte";
    import { fade, fly, scale } from "svelte/transition";
    import { isSwarmThinking, activeTab } from "./stores";
    import { cubicOut } from "svelte/easing";

    const dispatch = createEventDispatcher();

    let { isOnline = null } = $props();

    let query = $state("");
    let inputEl: HTMLInputElement;
    let containerEl: HTMLDivElement;
    let mouseX = $state(0);
    let mouseY = $state(100);

    const SUGGESTIONS = [
        "Search for SpaceX news",
        "Summarize this page",
        "Open my wallet",
        "Research decentralized swarms",
    ];

    let isNewTab = $derived($activeTab?.url === "bucks://newtab");

    onMount(() => {
        if (isNewTab) inputEl?.focus();
    });

    function handleMouseMove(e: MouseEvent) {
        if (!containerEl) return;
        const rect = containerEl.getBoundingClientRect();
        mouseX = ((e.clientX - rect.left) / rect.width) * 100;
        mouseY = ((e.clientY - rect.top) / rect.height) * 100;
    }

    async function handleSubmit(e: SubmitEvent) {
        e.preventDefault();
        if (!query.trim() || $isSwarmThinking) return;
        dispatch("submit", { query });
        query = "";
    }

    function selectSuggestion(s: string) {
        query = s;
        if (!query.trim() || $isSwarmThinking) return;
        dispatch("submit", { query });
        query = "";
    }
</script>

<div
    bind:this={containerEl}
    onmousemove={handleMouseMove}
    role="presentation"
    class="agentic-bar-fixed fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-2xl z-[100] px-4 transition-all duration-1000
           {isNewTab
        ? 'pb-10 scale-100'
        : 'pb-0 scale-90 translate-y-2 hover:translate-y-0 opacity-40 hover:opacity-100 hover:scale-95'}"
    in:fly={{ y: 50, duration: 800, easing: cubicOut }}
>
    <!-- Aurora Glow Backdrop (Only visible on home or when thinking/hovered) -->
    <div
        class="absolute -inset-4 rounded-[40px] blur-3xl pointer-events-none transition-all duration-1000
               {isNewTab || $isSwarmThinking
            ? 'opacity-20'
            : 'opacity-0 group-hover:opacity-10'}"
        style="
            background: radial-gradient(circle at {mouseX}% {mouseY}%, #8b5cf6, #3b82f6, transparent);
        "
    ></div>

    <form
        onsubmit={handleSubmit}
        class="relative flex items-center bg-black/40 backdrop-blur-2xl border border-white/10 rounded-full p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.6)] group transition-all duration-1000 hover:border-white/20
               {isNewTab
            ? 'scale-110 shadow-[0_30px_80px_rgba(139,92,246,0.15)] bg-black/60'
            : 'bg-black/20 backdrop-blur-lg'}"
        class:thinking={$isSwarmThinking}
    >
        <!-- Status Indicator -->
        <div class="px-3 flex items-center justify-center">
            <div class="relative">
                {#if $isSwarmThinking}
                    <div
                        class="w-2 h-2 rounded-full bg-violet-400 animate-ping absolute inset-0"
                    ></div>
                {/if}
                <div
                    class="w-2 h-2 rounded-full shadow-lg transition-colors duration-500
                           {isOnline
                        ? 'bg-emerald-400/60 shadow-emerald-400/10'
                        : isOnline === false
                          ? 'bg-amber-400/60 shadow-amber-400/10'
                          : 'bg-white/10'}"
                ></div>
            </div>
        </div>

        <input
            bind:this={inputEl}
            bind:value={query}
            type="text"
            placeholder={$isSwarmThinking
                ? "Architect is orchestrating..."
                : isNewTab
                  ? "Welcome master! Command the swarm..."
                  : "Command the swarm..."}
            disabled={$isSwarmThinking}
            class="flex-1 bg-transparent border-none outline-none text-white text-sm font-light tracking-wide py-2.5 px-2 placeholder-white/20 disabled:opacity-50"
        />

        <!-- Action Button (Smaller in compact mode) -->
        <button
            type="submit"
            disabled={!query.trim() || $isSwarmThinking}
            class="ml-2 bg-white/5 hover:bg-white/10 text-white/80 rounded-full px-5 py-2 text-[10px] font-medium tracking-widest uppercase transition-all duration-300 disabled:opacity-0 disabled:translate-x-4 active:scale-95 border border-white/5"
        >
            {$isSwarmThinking ? "Wait" : "Send"}
        </button>
    </form>

    <!-- Suggestion Chips (Only on Home Page) -->
    {#if isNewTab && query === "" && !$isSwarmThinking}
        <div
            class="mt-4 flex flex-wrap justify-center gap-2"
            transition:fade={{ duration: 400 }}
        >
            {#each SUGGESTIONS as s}
                <button
                    onclick={() => selectSuggestion(s)}
                    class="text-[9px] text-white/30 hover:text-white/70 bg-white/[0.02] hover:bg-white/[0.05] border border-white/5 rounded-full px-3 py-1.5 transition-all duration-300 backdrop-blur-md"
                >
                    {s}
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .agentic-bar-fixed {
        filter: drop-shadow(0 0 20px rgba(0, 0, 0, 0.3));
    }

    form.thinking {
        border-color: rgba(139, 92, 246, 0.3);
        box-shadow:
            0 0 30px rgba(139, 92, 246, 0.1),
            0 20px 50px rgba(0, 0, 0, 0.5);
    }

    input::placeholder {
        transition: opacity 0.3s;
    }

    form:focus-within {
        border-color: rgba(255, 255, 255, 0.3);
        transform: translateY(-2px);
        background: rgba(0, 0, 0, 0.8) !important;
        opacity: 1 !important;
        scale: 1 !important;
    }
</style>
