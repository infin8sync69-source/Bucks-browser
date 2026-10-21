<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    import { onMount } from "svelte";
    import { fade, fly, scale } from "svelte/transition";
    import { isSwarmThinking, activeTab } from "./stores";
    import { agentBarRequest } from "./uiState";
    import SlashMenu from "./agent/SlashMenu.svelte";
    import { suggestSlash, type SlashCommand } from "./agent/slash";
    import { cubicOut } from "svelte/easing";
    import { MessageSquare } from "lucide-svelte";

    let {
        isOnline = null,
        slmReady = false,
        model = null,
        chatOpen = false,
        onsubmit,
        onopenchat,
    }: {
        isOnline?: boolean | null;
        slmReady?: boolean;
        model?: string | null;
        chatOpen?: boolean;
        onsubmit?: (q: string) => void;
        onopenchat?: () => void;
    } = $props();

    let query = $state("");
    let inputEl: HTMLInputElement;
    let containerEl: HTMLDivElement;
    let mouseX = $state(0);
    let mouseY = $state(100);

    const SUGGESTIONS = [
        "🚕 Book me a taxi",
        "🍕 Order food nearby",
        "💸 Send money",
        "🌤️ Check the weather",
        "📰 Latest crypto news",
        "🌐 Upload to IPFS",
    ];

    let isNewTab = $derived($activeTab?.url === "bucks://newtab");

    onMount(() => {
        if (isNewTab) inputEl?.focus();
    });

    // "Start a task" and similar buttons elsewhere in the chrome hand the bar a prompt to finish.
    let lastRequest = $agentBarRequest.n;
    $effect(() => {
        const r = $agentBarRequest;
        if (r.n === lastRequest) return;
        lastRequest = r.n;
        if (r.text) query = r.text;
        inputEl?.focus();
        if (r.text) inputEl?.setSelectionRange(r.text.length, r.text.length);
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
        onsubmit?.(query.trim());
        query = "";
    }

    // Slash commands: suggestions while the command name is typed.
    let slashIndex = $state(0);
    const slashItems = $derived(suggestSlash(query, 6));
    $effect(() => {
        void slashItems.length;
        slashIndex = 0;
    });

    function pickSlash(c: SlashCommand) {
        query = `${c.cmd} `;
        inputEl?.focus();
    }

    function onKeydown(e: KeyboardEvent) {
        if (!slashItems.length) return;
        if (e.key === "ArrowDown") { e.preventDefault(); slashIndex = (slashIndex + 1) % slashItems.length; }
        else if (e.key === "ArrowUp") { e.preventDefault(); slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length; }
        else if (e.key === "Tab" || (e.key === "Enter" && query.trim() !== slashItems[slashIndex]?.cmd)) { e.preventDefault(); pickSlash(slashItems[slashIndex]); }
        else if (e.key === "Escape") query = "";
    }

    function selectSuggestion(s: string) {
        query = s;
        if (!query.trim() || $isSwarmThinking) return;
        onsubmit?.(query.trim());
        query = "";
    }
</script>

<div
    bind:this={containerEl}
    onmousemove={handleMouseMove}
    role="presentation"
    class="agentic-bar-fixed relative w-full transition-all duration-slow
           {isNewTab
        ? 'pb-10'
        : 'pb-0 opacity-50 hover:opacity-100 hover:translate-y-[-2px]'}"
    in:fly={{ y: 50, duration: motion.slower, easing: cubicOut }}
>
    <!-- Aurora glow — only on newtab or while thinking -->
    {#if isNewTab || $isSwarmThinking}
        <div
            class="absolute -inset-4 rounded-4xl blur-3xl pointer-events-none opacity-20 transition-opacity duration-slowest"
            style="background: radial-gradient(circle at {mouseX}% {mouseY}%, var(--bucks-color-agent), var(--bucks-color-accent), transparent);"
        ></div>
    {/if}

    {#if slashItems.length}
        <SlashMenu items={slashItems} active={slashIndex} onpick={pickSlash} />
    {/if}

    <form
        onsubmit={handleSubmit}
        class="relative flex items-center bg-scrim/40 backdrop-blur-2xl border border-line-strong rounded-full p-1.5 shadow-float group transition-all duration-slowest hover:border-line-emphasis
               {isNewTab
            ? 'scale-110 shadow-glow-agent bg-scrim/60'
            : 'bg-scrim/20 backdrop-blur-lg'}"
        class:thinking={$isSwarmThinking}
    >
        <!-- Status Indicators -->
        <div class="px-3 flex items-center gap-1.5">
            <!-- Swarm / agent server dot -->
            <div class="relative" title={isOnline ? "Agent server online" : "Agent server offline"}>
                {#if $isSwarmThinking}
                    <div class="w-2 h-2 rounded-full bg-agent animate-ping absolute inset-0"></div>
                {/if}
                <div
                    class="w-2 h-2 rounded-full shadow-lg transition-colors duration-slow
                           {isOnline
                        ? 'bg-success/60 shadow-success/10'
                        : isOnline === false
                          ? 'bg-warning/60 shadow-warning/10'
                          : 'bg-surface-4'}"
                ></div>
            </div>
            <!-- Local model (Ollama) dot -->
            <div
                class="w-1.5 h-1.5 rounded-full transition-colors duration-slow {slmReady ? 'bg-info/70' : 'bg-surface-4'}"
                title={slmReady ? `${model ?? "Local model"} on-device ready` : "No on-device model connected"}
            ></div>
        </div>

        <input
            bind:this={inputEl}
            bind:value={query}
            onkeydown={onKeydown}
            aria-label="Ask the agent"
            type="text"
            placeholder={$isSwarmThinking
                ? "Thinking..."
                : isNewTab
                  ? slmReady ? "Command the swarm (on-device model)..." : "Command the swarm..."
                  : slmReady ? "Ask Bucks (on-device model)..." : "Command the swarm..."}
            disabled={$isSwarmThinking}
            class="flex-1 bg-transparent border-none outline-none text-fg text-md font-light tracking-wide py-2.5 px-2 placeholder-fg-faint disabled:opacity-50"
        />

        <!-- Chat history button -->
        <button
            type="button"
            onclick={onopenchat}
            title="Open chat"
            class="relative flex items-center justify-center w-8 h-8 rounded-full text-fg-faint hover:text-fg-muted hover:bg-surface-4 transition-all duration-moderate mr-1"
        >
            <MessageSquare size={14} />
            {#if chatOpen}
                <span class="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-agent"></span>
            {/if}
        </button>

        <!-- Action Button (Smaller in compact mode) -->
        <button
            type="submit"
            disabled={!query.trim() || $isSwarmThinking}
            class="ml-1 bg-surface-2 hover:bg-surface-4 text-fg-muted rounded-full px-5 py-2 text-3xs font-medium tracking-widest uppercase transition-all duration-moderate disabled:opacity-0 disabled:translate-x-4 active:scale-95 border border-line-subtle"
        >
            {$isSwarmThinking ? "Wait" : "Send"}
        </button>
    </form>

    <!-- Suggestion Chips (Only on Home Page) -->
    {#if isNewTab && query === "" && !$isSwarmThinking}
        <div
            class="mt-4 flex flex-wrap justify-center gap-2"
            transition:fade={{ duration: motion.moderate }}
        >
            {#each SUGGESTIONS as s}
                <button
                    onclick={() => selectSuggestion(s)}
                    class="text-3xs text-fg-faint hover:text-fg-muted bg-surface-1 hover:bg-surface-2 border border-line-subtle rounded-full px-3 py-1.5 transition-all duration-moderate backdrop-blur-md"
                >
                    {s}
                </button>
            {/each}
        </div>
    {/if}
</div>

<style>
    .agentic-bar-fixed {
        filter: drop-shadow(0 0 20px color-mix(in srgb, var(--bucks-color-scrim) 30%, transparent));
    }

    form.thinking {
        border-color: color-mix(in srgb, var(--bucks-color-agent) 30%, transparent);
        box-shadow: var(--bucks-shadow-thinking);
    }

    input::placeholder {
        transition: opacity var(--bucks-duration-moderate);
    }

    form:focus-within {
        border-color: var(--bucks-color-surface-6);
        transform: translateY(-2px);
        background: color-mix(in srgb, var(--bucks-color-scrim) 80%, transparent) !important;
        opacity: 1 !important;
        scale: 1 !important;
    }
</style>
