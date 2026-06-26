<script lang="ts">
    import { fade, fly } from "svelte/transition";
    import { cubicOut } from "svelte/easing";
    import { onMount, tick } from "svelte";
    import { swarmStore, type Message, type A2UI } from "./swarmStore";
    import { isSwarmThinking } from "./stores";
    import ChatMessage from "./ChatMessage.svelte";
    import { Send, X, RotateCcw, Zap, ChevronDown } from "lucide-svelte";

    let {
        isOnline = null,
        slmReady = false,
        onclose = () => {},
    }: { isOnline?: boolean | null; slmReady?: boolean; onclose?: () => void } = $props();

    let query     = $state("");
    let textareaEl: HTMLTextAreaElement;
    let scrollEl:   HTMLDivElement;
    let atBottom   = $state(true);

    // Auto-scroll to bottom when messages arrive
    $effect(() => {
        const msgs = $swarmStore.messages;
        if (msgs && atBottom) tick().then(scrollToBottom);
    });

    function scrollToBottom() {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
    }

    function onScroll() {
        if (!scrollEl) return;
        atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 40;
    }

    // Auto-grow textarea
    function autoGrow() {
        if (!textareaEl) return;
        textareaEl.style.height = "auto";
        textareaEl.style.height = Math.min(textareaEl.scrollHeight, 160) + "px";
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
        }
    }

    function submit() {
        if (!query.trim() || $isSwarmThinking) return;
        swarmStore.sendQuery(query.trim());
        query = "";
        tick().then(() => {
            if (textareaEl) { textareaEl.style.height = "auto"; textareaEl.focus(); }
        });
    }

    const SUGGESTIONS = [
        "🚕 Book a taxi",
        "🍕 Order food nearby",
        "💸 Send money",
        "🌤️ Check the weather",
        "📰 Latest crypto news",
        "✨ Open Mini App Lab",
        "🌐 Upload to IPFS",
    ];

    function suggest(s: string) {
        query = s.replace(/^[\p{Emoji}\s]+/u, "").trim();
        submit();
    }

    function copyMessage(msg: Message) {
        navigator.clipboard.writeText(msg.content || "");
    }

    function replayMessage(msg: Message) {
        if (!msg.content || $isSwarmThinking) return;
        swarmStore.sendQuery(msg.content);
    }

    function handleA2UIClick(event: CustomEvent<A2UI>) {
        swarmStore.dispatchA2UI(event.detail);
    }

    onMount(() => textareaEl?.focus());
</script>

<!-- Backdrop -->
<div
    class="fixed inset-0 z-[300] bg-black/30 backdrop-blur-sm"
    transition:fade={{ duration: 200 }}
    onclick={onclose}
    role="presentation"
></div>

<!-- Panel -->
<div
    class="fixed right-0 top-0 bottom-0 z-[301] w-full max-w-[440px] flex flex-col bg-[#0d0d10] border-l border-white/[0.07] shadow-2xl"
    transition:fly={{ x: 440, duration: 320, easing: cubicOut }}
>
    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="flex items-center gap-3 px-4 py-3.5 border-b border-white/[0.06] flex-shrink-0">
        <!-- Avatar -->
        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center flex-shrink-0">
            <Zap size={14} class="text-white" />
        </div>

        <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
                <span class="text-white text-sm font-semibold tracking-wide">Bucks AI</span>
                <!-- Online dot -->
                <span class="relative flex h-2 w-2">
                    {#if isOnline}
                        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-40"></span>
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
                    {:else}
                        <span class="relative inline-flex rounded-full h-2 w-2 bg-zinc-600"></span>
                    {/if}
                </span>
            </div>
            <p class="text-[10px] text-zinc-500 font-medium tracking-wider uppercase mt-0.5">
                {slmReady ? "qwen2.5:3b on-device" : "swarm intelligence"}
            </p>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-1">
            <button
                onclick={() => swarmStore.clearHistory()}
                title="New chat"
                class="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            >
                <RotateCcw size={14} />
            </button>
            <button
                onclick={onclose}
                class="p-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
            >
                <X size={15} />
            </button>
        </div>
    </div>

    <!-- ── Messages ────────────────────────────────────────────────────────── -->
    <div
        bind:this={scrollEl}
        onscroll={onScroll}
        class="flex-1 overflow-y-auto px-4 py-4 space-y-5 scroll-smooth"
        style="scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.06) transparent;"
    >
        <!-- Empty state -->
        {#if $swarmStore.messages.length === 0}
            <div class="flex flex-col items-center justify-center h-full gap-6 pb-8" transition:fade>
                <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600/20 to-indigo-700/20 border border-violet-500/20 flex items-center justify-center">
                    <Zap size={28} class="text-violet-400" />
                </div>
                <div class="text-center">
                    <p class="text-white/80 text-base font-medium">How can I help?</p>
                    <p class="text-zinc-500 text-xs mt-1">Ask me anything or try a suggestion below</p>
                </div>
                <!-- Suggestion grid -->
                <div class="grid grid-cols-2 gap-2 w-full">
                    {#each SUGGESTIONS as s}
                        <button
                            onclick={() => suggest(s)}
                            class="text-left px-3 py-2.5 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.06] hover:border-white/[0.12] text-zinc-400 hover:text-zinc-200 text-xs transition-all duration-200"
                        >
                            {s}
                        </button>
                    {/each}
                </div>
            </div>

        {:else}
            <!-- Message thread -->
            {#each $swarmStore.messages as msg (msg.ts)}
                <ChatMessage
                    {msg}
                    onCopy={() => copyMessage(msg)}
                    onReplay={() => replayMessage(msg)}
                    on:action={handleA2UIClick}
                />
            {/each}

            <!-- Thinking indicator -->
            {#if $isSwarmThinking}
                <div class="flex gap-2.5" transition:fade={{ duration: 150 }}>
                    <div class="w-7 h-7 rounded-full bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center flex-shrink-0">
                        <Zap size={12} class="text-white" />
                    </div>
                    <div class="bg-white/[0.05] border border-white/[0.07] px-4 py-3 rounded-2xl rounded-tl-md flex items-center gap-1.5">
                        <span class="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style="animation-delay:0ms"></span>
                        <span class="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style="animation-delay:150ms"></span>
                        <span class="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style="animation-delay:300ms"></span>
                    </div>
                </div>
            {/if}
        {/if}
    </div>

    <!-- Scroll-to-bottom button -->
    {#if !atBottom && $swarmStore.messages.length > 0}
        <button
            onclick={scrollToBottom}
            transition:fade={{ duration: 150 }}
            class="absolute bottom-24 right-5 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-zinc-300 transition-colors shadow-lg"
        >
            <ChevronDown size={16} />
        </button>
    {/if}

    <!-- ── Input area ──────────────────────────────────────────────────────── -->
    <div class="flex-shrink-0 border-t border-white/[0.06] p-3">
        <div class="flex items-end gap-2 bg-white/[0.04] border border-white/[0.08] rounded-2xl px-3 py-2 focus-within:border-violet-500/40 focus-within:bg-white/[0.06] transition-all duration-200">
            <textarea
                bind:this={textareaEl}
                bind:value={query}
                oninput={autoGrow}
                onkeydown={handleKeydown}
                disabled={$isSwarmThinking}
                placeholder={$isSwarmThinking ? "Bucks is thinking..." : "Message Bucks…"}
                rows="1"
                class="flex-1 bg-transparent resize-none border-none outline-none text-white text-sm leading-relaxed placeholder-zinc-600 disabled:opacity-50 min-h-[22px] max-h-[160px] py-0.5"
            ></textarea>

            <button
                onclick={submit}
                disabled={!query.trim() || $isSwarmThinking}
                class="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-200
                       {query.trim() && !$isSwarmThinking
                           ? 'bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-500/20'
                           : 'bg-white/5 text-zinc-600 cursor-not-allowed'}"
            >
                <Send size={14} />
            </button>
        </div>
        <p class="text-center text-[10px] text-zinc-700 mt-2">
            Shift+Enter for new line · Enter to send
        </p>
    </div>
</div>

<style>
    /* Custom thin scrollbar */
    div::-webkit-scrollbar       { width: 4px; }
    div::-webkit-scrollbar-track { background: transparent; }
    div::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 4px; }
    div::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.12); }
</style>
