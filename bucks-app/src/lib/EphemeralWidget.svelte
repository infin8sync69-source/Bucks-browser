<script lang="ts">
    import { fly, fade, scale } from "svelte/transition";
    import { onMount, createEventDispatcher } from "svelte";
    import { cubicOut, elasticOut } from "svelte/easing";
    import { swarmStore } from "./swarmStore";

    const dispatch = createEventDispatcher();

    export let type: string = "text";
    export let content: string = "";
    export let description: string = ""; // conversational evaluation text from Architect
    export let selector: string = "";
    export let text: string = "";
    export let url: string = "";
    export let language: string = "javascript";
    export let taskId: string | null = null;
    export let cid: string | null = null;
    export let data: any = null;

    let visible = true;
    let feedbackScore: number | null = null;
    let showCorrection = false;
    let correctionText = "";

    function handleFeedback(score: number) {
        if (!taskId) return;
        feedbackScore = score;
        if (score === 1) {
            swarmStore.sendFeedback(taskId, 1);
            // Show a brief thank you or just keep it highlighted
        } else {
            showCorrection = true;
        }
    }

    function submitCorrection() {
        if (!taskId) return;
        swarmStore.sendFeedback(taskId, -1, correctionText);
        showCorrection = false;
        correctionText = "";
    }

    // Auto-dismiss or allow manual close
    function close() {
        visible = false;
        setTimeout(() => dispatch("close"), 500);
    }
</script>

{#if visible}
    <div
        class="ephemeral-widget fixed top-24 right-8 w-80 z-[110]"
        in:fly={{ x: 100, duration: 800, easing: cubicOut }}
        out:fade={{ duration: 300 }}
    >
        <div
            class="bg-black/40 backdrop-blur-3xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
        >
            <!-- Header -->
            <div
                class="px-4 py-2 border-b border-white/5 flex items-center justify-between bg-white/[0.02]"
            >
                <div class="flex items-center gap-2">
                    <span
                        class="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse"
                    ></span>
                    <span
                        class="text-[9px] font-bold uppercase tracking-widest text-white/40"
                        >Swarm Insight</span
                    >
                </div>
                <button
                    on:click={close}
                    class="text-white/20 hover:text-white/60 transition-colors"
                    aria-label="Close insight"
                >
                    <svg
                        class="w-3 h-3"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M6 18L18 6M6 6l12 12"
                        ></path>
                    </svg>
                </button>
            </div>

            <!-- Content Body -->
            <div class="p-4">
                <!-- Conversational text part (evaluation from Architect) -->
                {#if description}
                    <p
                        class="text-sm text-white/80 leading-relaxed font-light mb-4"
                    >
                        {description}
                    </p>
                {/if}

                <!-- A2UI specific action part -->
                {#if type === "navigate" || type === "search"}
                    <a
                        href={url || "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="flex items-center gap-3 mb-2 p-2 bg-blue-500/5 rounded-xl border border-blue-500/10 hover:border-blue-500/20 transition-all group no-underline"
                    >
                        <div
                            class="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400"
                        >
                            {#if type === "navigate"}
                                <svg
                                    class="w-4 h-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                    ><path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                                    ></path></svg
                                >
                            {:else}
                                <svg
                                    class="w-4 h-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                    ><path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                                    ></path></svg
                                >
                            {/if}
                        </div>
                        <div class="flex-1 min-w-0">
                            <p
                                class="text-[10px] text-white/30 uppercase tracking-tighter"
                            >
                                {type === "navigate"
                                    ? "Navigation Link"
                                    : "Search Term"}
                            </p>
                            <p
                                class="text-xs text-blue-300 font-medium truncate"
                            >
                                {url || text || "External Link"}
                            </p>
                        </div>
                    </a>
                {:else if type === "click" || type === "type"}
                    <div
                        class="flex items-center gap-3 mb-2 p-2 bg-orange-500/5 rounded-xl border border-orange-500/10"
                    >
                        <div
                            class="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-400"
                        >
                            <svg
                                class="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                                ><path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"
                                ></path></svg
                            >
                        </div>
                        <div>
                            <p
                                class="text-[10px] text-white/30 uppercase tracking-tighter"
                            >
                                {type === "click"
                                    ? "Planned Interaction"
                                    : "Planned Input"}
                            </p>
                            <p
                                class="text-xs text-orange-300 font-medium truncate w-48"
                            >
                                {type === "click"
                                    ? `Click ${selector}`
                                    : `Type "${text}"`}
                            </p>
                        </div>
                    </div>
                {:else if type === "code"}
                    <div class="mb-2">
                        <div class="flex items-center gap-2 mb-1.5 px-1">
                            <span
                                class="text-[8px] font-mono text-emerald-400/60 uppercase"
                                >{language || "code"}</span
                            >
                        </div>
                        <pre
                            class="text-[10px] font-mono text-emerald-300/80 bg-black/40 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap border border-white/5 shadow-inner">{text ||
                                content}</pre>
                    </div>
                {:else if type === "widget" && data}
                    <div
                        class="p-2 bg-white/[0.02] rounded-lg border border-white/5"
                    >
                        <pre
                            class="text-[9px] font-mono text-amber-300/70 overflow-x-auto">{JSON.stringify(
                                data,
                                null,
                                2,
                            )}</pre>
                    </div>
                {/if}
            </div>

            <!-- IPFS Footer if CID present -->
            {#if cid}
                <div
                    class="px-4 py-2 border-t border-white/5 bg-cyan-400/[0.02] flex items-center justify-between"
                >
                    <span
                        class="text-[8px] text-cyan-400/40 uppercase font-bold tracking-[0.2em]"
                        >Verifiable Fragment</span
                    >
                    <a
                        href="https://ipfs.io/ipfs/{cid}"
                        target="_blank"
                        class="text-[10px] font-mono text-cyan-300/60 hover:text-cyan-200 flex items-center gap-1"
                    >
                        {cid.slice(0, 4)}...{cid.slice(-4)} ↗
                    </a>
                </div>
            {/if}

            <!-- Feedback Section -->
            {#if taskId && !showCorrection}
                <div
                    class="px-3 py-2 flex items-center justify-end gap-2 border-t border-white/5 bg-white/[0.01]"
                >
                    <span
                        class="text-[8px] text-white/20 uppercase tracking-widest mr-auto pl-1"
                        >Teach Agent</span
                    >
                    <button
                        on:click={() => handleFeedback(1)}
                        class="p-1.5 rounded-md hover:bg-emerald-500/10 transition-colors {feedbackScore ===
                        1
                            ? 'text-emerald-400 bg-emerald-500/10'
                            : 'text-white/20'}"
                        title="Correct / Helpful"
                    >
                        <svg
                            class="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M5 13l4 4L19 7"
                            ></path></svg
                        >
                    </button>
                    <button
                        on:click={() => handleFeedback(-1)}
                        class="p-1.5 rounded-md hover:bg-rose-500/10 transition-colors {feedbackScore ===
                        -1
                            ? 'text-rose-400 bg-rose-500/10'
                            : 'text-white/20'}"
                        title="Needs Correction"
                    >
                        <svg
                            class="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M6 18L18 6M6 6l12 12"
                            ></path></svg
                        >
                    </button>
                </div>
            {:else if showCorrection}
                <div
                    class="p-3 border-t border-white/5 bg-rose-500/[0.02]"
                    in:scale={{ duration: 200, start: 0.95 }}
                >
                    <textarea
                        bind:value={correctionText}
                        placeholder="What should it have done?"
                        class="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-[10px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-rose-500/40 resize-none h-16"
                    ></textarea>
                    <div class="flex justify-end gap-2 mt-2">
                        <button
                            on:click={() => (showCorrection = false)}
                            class="px-2 py-1 text-[9px] text-white/40 hover:text-white/60"
                            >Cancel</button
                        >
                        <button
                            on:click={submitCorrection}
                            class="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-[9px] rounded-md transition-colors"
                        >
                            Submit Correction
                        </button>
                    </div>
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    .ephemeral-widget {
        filter: drop-shadow(0 0 30px rgba(0, 0, 0, 0.4));
    }
</style>
