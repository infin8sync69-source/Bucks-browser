<script lang="ts">
    // Earlier conversations: open, rename (double-click) or delete one.
    import { Plus, Trash2 } from "lucide-svelte";
    import { swarmStore } from "$lib/swarmStore";
    import { threadDay } from "./threads";

    let { onclose }: { onclose: () => void } = $props();

    let editing = $state<string | null>(null);
    let draft = $state("");

    function open(id: string) {
        swarmStore.openThread(id);
        onclose();
    }

    function commit(id: string) {
        swarmStore.renameThread(id, draft);
        editing = null;
    }
</script>

<div class="absolute inset-0 z-20 flex flex-col bg-[#0d0d10]" aria-label="Chats">
    <div class="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <p class="text-[13px] text-white/80">Chats</p>
        <button onclick={() => { swarmStore.newChat(); onclose(); }}
            class="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[11px] text-white/70"><Plus size={12} /> New chat</button>
        <button onclick={onclose} class="px-2.5 py-1 rounded-lg hover:bg-white/10 text-[11px] text-white/50">Back</button>
    </div>
    <div class="flex-1 overflow-y-auto p-2">
        {#if $swarmStore.threads.length === 0}
            <p class="px-3 py-6 text-center text-[12px] text-white/30">No saved chats yet.</p>
        {/if}
        {#each $swarmStore.threads as t (t.id)}
            <div class="group flex items-center gap-2 rounded-xl px-3 py-2 {t.id === $swarmStore.threadId ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}">
                {#if editing === t.id}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input bind:value={draft} autofocus aria-label="Chat name"
                        onkeydown={(e) => { if (e.key === "Enter") commit(t.id); if (e.key === "Escape") editing = null; }}
                        onblur={() => commit(t.id)}
                        class="flex-1 min-w-0 bg-white/[0.06] border border-white/10 rounded-lg px-2 py-1 text-[12px] text-white/85 outline-none" />
                {:else}
                    <button onclick={() => open(t.id)} ondblclick={() => { editing = t.id; draft = t.title; }} class="flex-1 min-w-0 text-left" title="Open (double-click to rename)">
                        <span class="block text-[12px] text-white/80 truncate">{t.title}</span>
                        <span class="block text-[10px] text-white/30">{threadDay(t.updatedAt)} · {t.messages.length} message{t.messages.length === 1 ? "" : "s"}</span>
                    </button>
                    <button onclick={() => swarmStore.deleteThread(t.id)} title="Delete chat" aria-label="Delete {t.title}"
                        class="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-white/40 hover:text-red-300 hover:bg-white/10 transition-opacity"><Trash2 size={12} /></button>
                {/if}
            </div>
        {/each}
    </div>
</div>
