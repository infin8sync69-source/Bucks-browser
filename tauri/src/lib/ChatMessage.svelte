<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { Copy, RefreshCcw, MessageCircle, Cpu } from "lucide-svelte";
    import A2UIPill from "./A2UIPill.svelte";
    import type { Message, A2UI } from "./swarmStore";

    export let msg: Message;
    export let onCopy: () => void = () => {};
    export let onReplay: () => void = () => {};
    export let onAction: (a2ui: A2UI) => void = () => {};

    const isAgent = msg.role === "agent";
    const label = isAgent ? "Bucks AI" : msg.role === "user" ? "You" : "System";

    function formatTime(timestamp?: number) {
        if (!timestamp) return "";
        return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function renderContent(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
            .replace(/`(.*?)`/g, "<code>$1</code>")
            .replace(/\n/g, "<br>");
    }

    function handleAction() {
        if (msg.a2ui) onAction(msg.a2ui);
    }
</script>

<div class="group mb-4 rounded-2xl border p-4 shadow-sm transition hover:border-white/20 hover:bg-white/5">
    <div class="mb-3 flex items-start justify-between gap-3">
        <div class="flex items-center gap-2 text-sm text-slate-300">
            <span class="rounded-full bg-slate-700/60 px-2 py-1 text-xs uppercase tracking-[0.22em]">{label}</span>
            {#if msg.role !== "user"}
                <Cpu size="14" class="text-slate-400" />
            {/if}
        </div>
        {#if msg.ts}
            <span class="text-xs text-slate-500">{formatTime(msg.ts)}</span>
        {/if}
    </div>

    <div class="prose prose-invert max-w-none text-sm leading-6">
        {@html renderContent(msg.content || "")}
    </div>

    <div class="mt-4 flex flex-wrap items-center gap-2">
        <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
            on:click={onCopy}
        >
            <Copy size="14" />
            Copy
        </button>
        {#if isAgent && msg.content}
            <button
                type="button"
                class="inline-flex items-center gap-2 rounded-full bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500"
                on:click={onReplay}
            >
                <RefreshCcw size="14" />
                Ask again
            </button>
        {/if}
        {#if msg.a2ui}
            <button
                type="button"
                class="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
                on:click={handleAction}
            >
                <MessageCircle size="14" />
                Run action
            </button>
        {/if}
    </div>

    {#if msg.a2ui}
        <div class="mt-4 flex flex-wrap gap-2">
            <A2UIPill a2ui={msg.a2ui} on:click={handleAction} />
        </div>
    {/if}
</div>
