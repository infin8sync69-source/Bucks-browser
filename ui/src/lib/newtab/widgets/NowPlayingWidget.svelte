<script lang="ts">
    // Tabs that are playing sound (or that you muted), with mute and switch.
    import { Volume2, VolumeX } from "lucide-svelte";
    import { browserStore } from "$lib/stores";
    import type { Widget } from "../board";

    // Same props as every widget; this one has no settings.
    let _props: { widget?: Widget } = $props();

    const playing = $derived($browserStore.tabs.filter((t) => t.audible || t.muted));
</script>

{#if playing.length === 0}
    <p class="text-[11px] text-white/30">No tab is playing sound.</p>
{:else}
    <div class="space-y-1">
        {#each playing as t (t.id)}
            <div class="flex items-center gap-2">
                <button onclick={() => browserStore.setActiveTab(t.id)} class="min-w-0 flex-1 text-left text-[12px] text-white/75 hover:text-white truncate" title="Switch to this tab">
                    {t.customTitle || t.title || t.url}
                </button>
                <button onclick={() => browserStore.setMuted(t.id, !t.muted)} title={t.muted ? "Unmute" : "Mute"} aria-label={t.muted ? "Unmute" : "Mute"}
                    class="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/10 {t.muted ? 'text-white/35' : 'text-emerald-300/80'}">
                    {#if t.muted}<VolumeX size={12} />{:else}<Volume2 size={12} />{/if}
                </button>
            </div>
        {/each}
    </div>
{/if}
