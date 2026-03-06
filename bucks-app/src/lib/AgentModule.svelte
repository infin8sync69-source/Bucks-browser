<!--
  AgentModule.svelte — Full Agentic Browser Interface
  Connects to the Solar Parsec Architect via the Tauri backend bridge.
  Parses A2UI JSON from the agent evaluation and dispatches real browser actions.
-->
<script lang="ts">
    import { fade, slide } from "svelte/transition";
    import { invoke } from "@tauri-apps/api/core";
    import { browserStore, isSwarmThinking, activeTab } from "$lib/stores";
    import { onMount } from "svelte";

    // ── Types ────────────────────────────────────────────────────────────────
    type A2UIType =
        | "navigate"
        | "open_tab"
        | "search"
        | "click"
        | "type"
        | "scrape"
        | "action"
        | "text"
        | "code"
        | "terminal_output"
        | "widget"
        | "error";

    interface A2UI {
        type: A2UIType;
        content?: string;
        url?: string;
        action?: string;
        selector?: string;
        text?: string;
        data?: Record<string, unknown>;
        language?: string;
    }

    interface Message {
        role: "user" | "agent" | "error";
        content: string;
        a2ui?: A2UI | null;
        cid?: string | null;
        ts: number;
    }

    // ── State ────────────────────────────────────────────────────────────────
    let query = $state("");
    let isOnline = $state<boolean | null>(null);
    let messages = $state<Message[]>([]);
    let inputEl: HTMLInputElement;
    let chatEl = $state<HTMLDivElement | null>(null);

    // ── Mount: health check ───────────────────────────────────────────────────
    onMount(async () => {
        try {
            isOnline = await invoke<boolean>("check_architect_status");
        } catch {
            isOnline = false;
        }
    });

    // ── URL Detection ─────────────────────────────────────────────────────────
    function isURL(text: string): boolean {
        return (
            /^(https?:\/\/|file:\/\/|ipfs:\/\/|ipns:\/\/)/i.test(text) ||
            (/^[\w-]+(\.[\w-]+)+/.test(text) && !text.includes(" "))
        );
    }

    // ── A2UI Action Dispatcher ─────────────────────────────────────────────────
    async function dispatchA2UI(a2ui: A2UI) {
        const type = a2ui.type;

        if (type === "navigate" && a2ui.url) {
            const url = a2ui.url.startsWith("http")
                ? a2ui.url
                : "https://" + a2ui.url;
            browserStore.navigateActiveTab(url);
        } else if (type === "open_tab" && a2ui.url) {
            browserStore.createTab(a2ui.url);
        } else if (type === "search") {
            const q = encodeURIComponent(a2ui.content || "");
            browserStore.createTab(`https://duckduckgo.com/?q=${q}`);
        } else if (type === "click") {
            console.log(`[Swarm] Executing CLICK on: ${a2ui.selector}`);
            // In a real browser, this would use tauri's eval_script or similar
            // For now, we log the intent.
        } else if (type === "type") {
            console.log(`[Swarm] TYPING "${a2ui.text}" into: ${a2ui.selector}`);
        } else if (type === "scrape") {
            console.log(`[Swarm] SCRAPING page content from: ${a2ui.selector}`);
        } else if (type === "action") {
            switch (a2ui.action) {
                case "open_wallet":
                    setTimeout(
                        () => browserStore.createOrFocusTab("bucks://wallet"),
                        800,
                    );
                    break;
                case "start_tor_node":
                    await invoke("start_tor_node");
                    break;
                case "open_ipfs":
                    browserStore.createTab("ipfs://");
                    break;
                default:
                    console.log("[A2UI] Unknown action:", a2ui.action);
            }
        }
    }

    // ── Submit handler ─────────────────────────────────────────────────────────
    async function handleSubmit(e?: Event) {
        if (e) e.preventDefault();
        const text = query.trim();
        if (!text || $isSwarmThinking) return;

        // Direct URL → open in browser immediately
        if (isURL(text)) {
            const url = /^https?:\/\//i.test(text) ? text : "https://" + text;
            browserStore.createTab(url);
            query = "";
            return;
        }

        messages = [
            ...messages,
            { role: "user", content: text, ts: Date.now() },
        ];
        query = "";
        $isSwarmThinking = true;

        scrollToBottom();

        try {
            const raw = await invoke<string>("query_swarm", {
                prompt: text,
                current_url: $activeTab?.url || null,
                current_title: $activeTab?.title || null,
            });
            const result = JSON.parse(raw) as {
                status: string;
                evaluation: string;
                cid?: string | null;
                a2ui?: A2UI | null;
            };

            const a2ui = result.a2ui ?? null;
            const succeeded = result.status !== "error";

            const msg: Message = {
                role: succeeded ? "agent" : "error",
                content: result.evaluation || "No response.",
                a2ui,
                cid: result.cid,
                ts: Date.now(),
            };

            messages = [...messages, msg];
            isOnline = result.status !== "offline_fallback";

            // Auto-dispatch if action type
            if (
                a2ui &&
                [
                    "navigate",
                    "open_tab",
                    "search",
                    "click",
                    "type",
                    "scrape",
                    "action",
                ].includes(a2ui.type)
            ) {
                await dispatchA2UI(a2ui);
            }
        } catch (err: any) {
            messages = [
                ...messages,
                {
                    role: "error",
                    content: String(err?.message ?? err ?? "Unknown error"),
                    ts: Date.now(),
                },
            ];
            isOnline = false;
        } finally {
            $isSwarmThinking = false;
            scrollToBottom();
        }
    }

    function scrollToBottom() {
        setTimeout(() => {
            if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
        }, 100);
    }

    function clearHistory() {
        messages = [];
    }

    const SUGGESTIONS = [
        "Open YouTube",
        "Search the latest AI news",
        "Go to github.com",
        "Open my wallet",
    ];
</script>

<div class="w-full max-w-xl mx-auto flex flex-col gap-4">
    <!-- Branding -->
    <div
        class="flex flex-col items-center mb-8 mt-6"
        in:fade={{ duration: 800 }}
    >
        <img
            src="/logo.png"
            alt="Bucks"
            class="h-12 w-auto object-contain mb-3 opacity-70 hover:opacity-100 transition-opacity"
        />
        <p
            class="text-[9px] font-medium text-white/30 tracking-[0.5em] uppercase"
        >
            Soul of the World
        </p>
    </div>

    <!-- Chat history -->
    {#if messages.length > 0}
        <div
            bind:this={chatEl}
            class="flex flex-col gap-3 max-h-[44vh] overflow-y-auto pr-1 scroll-smooth"
            in:slide={{ duration: 300 }}
        >
            {#each messages as msg (msg.ts)}
                <div
                    in:slide={{ duration: 300 }}
                    class="flex {msg.role === 'user'
                        ? 'justify-end'
                        : 'justify-start'}"
                >
                    {#if msg.role === "user"}
                        <!-- User Bubble -->
                        <div
                            class="max-w-[80%] bg-white/5 border border-white/10 rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm text-white/80 font-light tracking-wide"
                        >
                            {msg.content}
                        </div>
                    {:else if msg.role === "agent"}
                        <!-- Agent Response -->
                        <div
                            class="max-w-[92%] w-full bg-black/30 border border-white/5 rounded-2xl rounded-tl-sm backdrop-blur-2xl shadow-2xl overflow-hidden"
                        >
                            <!-- Header -->
                            <div
                                class="flex items-center gap-2 px-5 pt-4 pb-2 border-b border-white/5"
                            >
                                <span
                                    class="w-1.5 h-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.6)] animate-pulse"
                                ></span>
                                <span
                                    class="text-[9px] font-bold uppercase tracking-[0.3em] text-white/50"
                                    >Swarm Intelligence</span
                                >
                                {#if msg.a2ui}
                                    <span
                                        class="ml-auto text-[9px] px-2 py-0.5 rounded-full bg-white/5 text-white/30 uppercase tracking-wider"
                                        >{msg.a2ui.type}</span
                                    >
                                {/if}
                            </div>

                            <!-- A2UI: Navigate / open_tab feedback -->
                            {#if msg.a2ui && (msg.a2ui.type === "navigate" || msg.a2ui.type === "open_tab" || msg.a2ui.type === "search")}
                                <div class="px-5 py-3 flex items-center gap-3">
                                    <div
                                        class="w-8 h-8 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0"
                                    >
                                        <svg
                                            width="14"
                                            height="14"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="#60a5fa"
                                            stroke-width="2"
                                        >
                                            <path
                                                d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
                                            />
                                            <polyline points="15 3 21 3 21 9" />
                                            <line
                                                x1="10"
                                                y1="14"
                                                x2="21"
                                                y2="3"
                                            />
                                        </svg>
                                    </div>
                                    <div>
                                        <p
                                            class="text-xs text-blue-300 font-medium"
                                        >
                                            Opening tab
                                        </p>
                                        <p
                                            class="text-[11px] text-white/40 font-mono truncate max-w-[240px]"
                                        >
                                            {msg.a2ui.url || msg.a2ui.content}
                                        </p>
                                    </div>
                                    <button
                                        onclick={() => {
                                            if (msg.a2ui?.url)
                                                browserStore.createTab(
                                                    msg.a2ui.url,
                                                );
                                        }}
                                        class="ml-auto text-[10px] bg-blue-500/10 hover:bg-blue-500/20 border border-blue-400/20 text-blue-300 rounded-lg px-3 py-1.5 transition"
                                    >
                                        Open
                                    </button>
                                </div>

                                <!-- A2UI: Click / Type / Scrape -->
                            {:else if msg.a2ui && (msg.a2ui.type === "click" || msg.a2ui.type === "type" || msg.a2ui.type === "scrape")}
                                <div class="px-5 py-3 flex items-center gap-3">
                                    <div
                                        class="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0
                                        {msg.a2ui.type === 'click'
                                            ? 'bg-orange-500/10'
                                            : msg.a2ui.type === 'type'
                                              ? 'bg-purple-500/10'
                                              : 'bg-cyan-500/10'}"
                                    >
                                        {#if msg.a2ui.type === "click"}
                                            <span
                                                class="text-xs text-orange-400"
                                                >🖱️</span
                                            >
                                        {:else if msg.a2ui.type === "type"}
                                            <span
                                                class="text-xs text-purple-400"
                                                >⌨️</span
                                            >
                                        {:else}
                                            <span class="text-xs text-cyan-400"
                                                >🔍</span
                                            >
                                        {/if}
                                    </div>
                                    <div class="flex-1 min-w-0">
                                        <p
                                            class="text-xs font-medium
                                            {msg.a2ui.type === 'click'
                                                ? 'text-orange-300'
                                                : msg.a2ui.type === 'type'
                                                  ? 'text-purple-300'
                                                  : 'text-cyan-300'}"
                                        >
                                            {msg.a2ui.type === "click"
                                                ? "Clicking Element"
                                                : msg.a2ui.type === "type"
                                                  ? "Typing Text"
                                                  : "Scraping Content"}
                                        </p>
                                        <p
                                            class="text-[10px] text-white/40 truncate"
                                        >
                                            {msg.a2ui.selector || "body"}
                                            {msg.a2ui.text
                                                ? ` → "${msg.a2ui.text}"`
                                                : ""}
                                        </p>
                                    </div>
                                    <span
                                        class="text-[9px] text-white/20 uppercase tracking-tighter italic"
                                        >Auto</span
                                    >
                                </div>

                                <!-- A2UI: Action card -->
                            {:else if msg.a2ui && msg.a2ui.type === "action"}
                                <div class="px-5 py-3 flex items-center gap-3">
                                    <div
                                        class="w-8 h-8 rounded-xl bg-emerald-500/10 flex items-center justify-center flex-shrink-0"
                                    >
                                        <span class="text-sm">⚡</span>
                                    </div>
                                    <div>
                                        <p
                                            class="text-xs text-emerald-300 font-medium capitalize"
                                        >
                                            {msg.a2ui.action?.replace(
                                                /_/g,
                                                " ",
                                            )}
                                        </p>
                                        <p class="text-[11px] text-white/40">
                                            {msg.a2ui.content}
                                        </p>
                                    </div>
                                </div>

                                <!-- A2UI: Code block -->
                            {:else if msg.a2ui && (msg.a2ui.type === "code" || msg.a2ui.type === "terminal_output")}
                                <div class="px-5 py-3">
                                    <div class="flex items-center gap-2 mb-2">
                                        <span
                                            class="text-[9px] font-mono text-green-400/60 uppercase"
                                            >{msg.a2ui.language || "code"}</span
                                        >
                                    </div>
                                    <pre
                                        class="text-[11px] font-mono text-green-300/80 bg-black/20 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">{msg
                                            .a2ui.content || ""}</pre>
                                </div>

                                <!-- A2UI: Widget / structured JSON -->
                            {:else if msg.a2ui && msg.a2ui.type === "widget"}
                                <div class="px-5 py-3">
                                    <pre
                                        class="text-[11px] font-mono text-yellow-300/70 bg-black/20 rounded-lg p-3 overflow-x-auto">{JSON.stringify(
                                            msg.a2ui.data,
                                            null,
                                            2,
                                        )}</pre>
                                </div>
                                <!-- Default: prose text -->
                            {:else}
                                <div class="px-5 py-4">
                                    <p
                                        class="text-[14px] text-white/80 leading-relaxed font-light tracking-wide whitespace-pre-wrap"
                                    >
                                        {msg.content}
                                    </p>
                                </div>
                            {/if}

                            {#if msg.cid}
                                <div
                                    class="px-5 pb-3 pt-2 border-t border-white/5 flex items-center justify-between"
                                >
                                    <div class="flex items-center gap-1.5">
                                        <div
                                            class="w-1.2 h-1.2 rounded-full bg-cyan-400/50 shadow-[0_0_8px_rgba(34,211,238,0.4)]"
                                        ></div>
                                        <span
                                            class="text-[8px] text-white/30 tracking-[0.2em] font-bold uppercase"
                                            >Verifiable Fragment</span
                                        >
                                    </div>
                                    <a
                                        href="https://ipfs.io/ipfs/{msg.cid}"
                                        target="_blank"
                                        class="text-[10px] font-mono text-cyan-300/60 hover:text-cyan-200 transition-colors flex items-center gap-1"
                                    >
                                        {msg.cid.slice(0, 6)}...{msg.cid.slice(
                                            -4,
                                        )}
                                        <svg
                                            class="w-2.5 h-2.5"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                stroke-width="2"
                                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                                            ></path>
                                        </svg>
                                    </a>
                                </div>
                            {/if}
                        </div>
                    {:else}
                        <!-- Error -->
                        <div
                            class="max-w-[90%] bg-red-950/30 border border-red-400/15 rounded-2xl rounded-tl-sm px-5 py-3 backdrop-blur-xl"
                        >
                            <div class="flex items-center gap-2 mb-1">
                                <span
                                    class="w-1.5 h-1.5 rounded-full bg-red-400"
                                ></span>
                                <span
                                    class="text-[9px] font-bold uppercase tracking-[0.3em] text-red-300/60"
                                    >Error</span
                                >
                            </div>
                            <p
                                class="text-red-200/70 text-[13px] leading-relaxed"
                            >
                                {msg.content}
                            </p>
                        </div>
                    {/if}
                </div>
            {/each}

            <!-- Thinking -->
            {#if $isSwarmThinking}
                <div in:fade class="flex justify-start">
                    <div
                        class="bg-black/30 border border-white/5 rounded-2xl px-5 py-3.5 backdrop-blur-xl"
                    >
                        <div class="flex items-center gap-2">
                            <div
                                class="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce"
                                style="animation-delay:0ms"
                            ></div>
                            <div
                                class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce"
                                style="animation-delay:120ms"
                            ></div>
                            <div
                                class="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce"
                                style="animation-delay:240ms"
                            ></div>
                            <span
                                class="ml-2 text-[10px] text-white/30 tracking-widest uppercase"
                                >Swarm Processing...</span
                            >
                        </div>
                    </div>
                </div>
            {/if}
        </div>

        <!-- Clear -->
        <div class="flex justify-center">
            <button
                onclick={clearHistory}
                class="text-[10px] text-white/15 hover:text-white/40 tracking-widest uppercase transition-colors"
            >
                Clear
            </button>
        </div>
    {/if}

    <!-- Suggestion chips — only shown on empty state -->
    {#if messages.length === 0 && !$isSwarmThinking}
        <div
            in:fade={{ delay: 500 }}
            class="flex flex-wrap justify-center gap-2 mb-2"
        >
            {#each SUGGESTIONS as s}
                <button
                    onclick={() => {
                        query = s;
                        handleSubmit();
                    }}
                    class="text-[10px] text-white/25 hover:text-white/60 border border-white/5 hover:border-white/15
                           rounded-full px-3 py-1.5 transition-all tracking-wide backdrop-blur-sm"
                >
                    {s}
                </button>
            {/each}
        </div>
    {/if}

    <!-- Input bar -->
    <form onsubmit={handleSubmit} class="w-full relative group">
        <!-- Glow halo -->
        <div
            class="absolute -inset-1 rounded-full blur-md transition duration-1000 {$isSwarmThinking
                ? 'bg-gradient-to-r from-violet-500/30 via-cyan-400/20 to-violet-500/30 opacity-90'
                : 'bg-gradient-to-r from-transparent via-white/4 to-transparent opacity-0 group-focus-within:opacity-100'}"
        ></div>

        <div
            class="relative bg-black/25 backdrop-blur-2xl rounded-full p-0.5 flex items-center
                    border-b border-white/5 group-focus-within:border-white/15 transition-all duration-500 shadow-2xl
                    {$isSwarmThinking
                ? '!border-violet-400/30 animate-pulse'
                : ''}"
        >
            <!-- Status dot -->
            <div class="pl-5 pr-2 flex-shrink-0">
                {#if $isSwarmThinking}
                    <div
                        class="w-2 h-2 rounded-full bg-violet-400 animate-ping shadow-[0_0_12px_rgba(167,139,250,0.9)]"
                    ></div>
                {:else if isOnline === true}
                    <div
                        class="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]"
                        title="Swarm online"
                    ></div>
                {:else if isOnline === false}
                    <div
                        class="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]"
                        title="Architect offline — local mode"
                    ></div>
                {:else}
                    <div
                        class="w-2 h-2 rounded-full bg-white/20 animate-pulse"
                    ></div>
                {/if}
            </div>

            <input
                bind:this={inputEl}
                bind:value={query}
                type="text"
                disabled={$isSwarmThinking}
                placeholder={$isSwarmThinking
                    ? "Swarm is working..."
                    : isOnline === false
                      ? "Offline mode — browse or command the agent..."
                      : "Ask the swarm, browse the web, run a task..."}
                class="w-full bg-transparent border-none outline-none text-white/80 placeholder-white/20
                       px-3 py-4 text-sm font-light tracking-wider disabled:opacity-50"
            />

            <button
                type="submit"
                disabled={$isSwarmThinking || !query.trim()}
                class="opacity-0 group-focus-within:opacity-100 bg-white/8 hover:bg-white/15 text-white
                       rounded-full px-5 py-2 mr-2 text-xs font-medium transition-all duration-300
                       active:scale-95 backdrop-blur-md disabled:opacity-20 disabled:pointer-events-none flex-shrink-0"
            >
                {$isSwarmThinking ? "..." : "Send"}
            </button>
        </div>
    </form>

    <!-- Status strip -->
    <div class="text-center min-h-[16px]">
        {#if isOnline === true && messages.length === 0}
            <p
                in:fade
                class="text-[10px] text-emerald-400/40 tracking-[0.3em] uppercase"
            >
                Swarm Online · Qwen2.5·3B
            </p>
        {:else if isOnline === false && messages.length === 0}
            <p
                in:fade
                class="text-[10px] text-amber-400/40 tracking-[0.3em] uppercase"
            >
                Offline Mode · Local Agent Active
            </p>
        {/if}
    </div>
</div>
