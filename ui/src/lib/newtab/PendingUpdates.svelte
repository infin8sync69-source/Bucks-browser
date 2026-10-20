<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    // Knowledge fragments and skill adapters that trusted peers offered the Soul Engine. Nothing is
    // adopted (fragment) or pinned (adapter) until you approve it here. Hidden when there are none.
    import { onMount } from "svelte";
    import { fly } from "svelte/transition";
    import { BookOpen, Puzzle } from "lucide-svelte";
    import { bucks, type SoulPendingUpdate } from "$lib/bridge";
    import { settingsStore } from "$lib/settingsStore";
    import { errorMessage } from "$lib/format";

    let updates = $state<SoulPendingUpdate[]>([]);
    let busy = $state<string | null>(null);
    let error = $state("");

    async function refresh() {
        if ($settingsStore?.agent.provider !== "soul") { updates = []; return; }
        updates = await bucks.agent.soulPending().catch(() => updates);
    }

    async function decide(u: SoulPendingUpdate, action: "approve" | "deny") {
        busy = u.id;
        error = "";
        try {
            updates = await bucks.agent.soulDecide(u.id, action);
        } catch (e) {
            error = errorMessage(e);
        } finally {
            busy = null;
        }
    }

    onMount(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 15_000);
        const stop = bucks.agent.onSoulStatus((s) => s.state === "ready" && void refresh());
        return () => { clearInterval(timer); stop(); };
    });

    const from = (u: SoulPendingUpdate) =>
        u.peer ? [u.peer.locality, u.peer.capabilities.join(", ")].filter(Boolean).join(" · ") || "a trusted peer" : `${u.peerSoulId.slice(0, 12)}…`;
</script>

{#if updates.length}
    <section class="w-full space-y-2" aria-label="Updates offered by peers">
        {#each updates as u (u.id)}
            <div class="flex items-center gap-3 rounded-2xl border border-warning/15 bg-warning/4 px-4 py-3" transition:fly={{ y: 6, duration: motion.base }}>
                <span class="text-warning-fg-strong/70 flex-shrink-0">{#if u.kind === "adapter"}<Puzzle size={16} />{:else}<BookOpen size={16} />{/if}</span>
                <div class="min-w-0 flex-1">
                    <p class="text-xs text-fg-muted">{u.kind === "adapter" ? "Skill update" : "Knowledge"} offered by {from(u)}</p>
                    <p class="text-2xs text-fg-faint truncate font-mono" title={u.cid}>{u.summary || u.cid}</p>
                </div>
                <button onclick={() => decide(u, "approve")} disabled={busy !== null}
                    class="px-3 py-1.5 rounded-lg bg-success/15 hover:bg-success/25 text-success-fg-strong text-2xs disabled:opacity-40 transition-colors">
                    {busy === u.id ? "…" : "Approve"}
                </button>
                <button onclick={() => decide(u, "deny")} disabled={busy !== null}
                    class="px-3 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-4 text-fg-subtle text-2xs disabled:opacity-40 transition-colors">
                    Deny
                </button>
            </div>
        {/each}
        {#if error}<p class="text-2xs text-danger-fg-strong/80 px-1" role="alert">{error}</p>{/if}
    </section>
{/if}
