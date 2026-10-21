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

<div class="absolute inset-0 z-float flex flex-col bg-surface-raised" aria-label="Chats">
    <div class="flex items-center gap-2 px-4 py-3 border-b border-line">
        <p class="text-sm text-fg-muted">Chats</p>
        <button onclick={() => { swarmStore.newChat(); onclose(); }}
            class="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-3 hover:bg-surface-4 text-2xs text-fg-muted"><Plus size={12} /> New chat</button>
        <button onclick={onclose} class="px-2.5 py-1 rounded-lg hover:bg-surface-4 text-2xs text-fg-faint">Back</button>
    </div>
    <div class="flex-1 overflow-y-auto p-2">
        {#if $swarmStore.threads.length === 0}
            <p class="px-3 py-6 text-center text-xs text-fg-faint">No saved chats yet.</p>
        {/if}
        {#each $swarmStore.threads as t (t.id)}
            <div class="group flex items-center gap-2 rounded-xl px-3 py-2 {t.id === $swarmStore.threadId ? 'bg-surface-3' : 'hover:bg-surface-2'}">
                {#if editing === t.id}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input bind:value={draft} autofocus aria-label="Chat name"
                        onkeydown={(e) => { if (e.key === "Enter") commit(t.id); if (e.key === "Escape") editing = null; }}
                        onblur={() => commit(t.id)}
                        class="flex-1 min-w-0 bg-surface-3 border border-line-strong rounded-lg px-2 py-1 text-xs text-fg-muted outline-none" />
                {:else}
                    <button onclick={() => open(t.id)} ondblclick={() => { editing = t.id; draft = t.title; }} class="flex-1 min-w-0 text-left" title="Open (double-click to rename)">
                        <span class="block text-xs text-fg-muted truncate">{t.title}</span>
                        <span class="block text-3xs text-fg-faint">{threadDay(t.updatedAt)} · {t.messages.length} message{t.messages.length === 1 ? "" : "s"}</span>
                    </button>
                    <button onclick={() => swarmStore.deleteThread(t.id)} title="Delete chat" aria-label="Delete {t.title}"
                        class="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-fg-faint hover:text-danger-fg-strong hover:bg-surface-4 transition-opacity"><Trash2 size={12} /></button>
                {/if}
            </div>
        {/each}
    </div>
</div>
