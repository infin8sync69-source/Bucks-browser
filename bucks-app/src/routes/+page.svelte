<script lang="ts">
    import Header from "$lib/Header.svelte";
    import BrowserView from "$lib/BrowserView.svelte";
    import AgenticBar from "$lib/AgenticBar.svelte";
    import EphemeralWidget from "$lib/EphemeralWidget.svelte";
    import LuminaHomepage from "$lib/LuminaHomepage.svelte";
    import { activeTab, isSwarmThinking } from "$lib/stores";
    import { swarmStore } from "$lib/swarmStore";
    import { onMount } from "svelte";

    onMount(() => {
        swarmStore.checkOnline();
    });

    function handleQuery(e: CustomEvent<{ query: string }>) {
        swarmStore.sendQuery(e.detail.query);
    }
</script>

<Header />

<main class="fixed inset-0 z-[100] pointer-events-none">
    <!-- Ephemeral UI Layers -->
    {#if $swarmStore.activeWidget}
        <div class="pointer-events-auto">
            <EphemeralWidget
                {...$swarmStore.activeWidget.a2ui || {}}
                description={$swarmStore.activeWidget.content}
                cid={$swarmStore.activeWidget.cid}
                taskId={$swarmStore.activeWidget.taskId}
                on:close={swarmStore.closeWidget}
            />
        </div>
    {/if}

    <div class="pointer-events-auto">
        <AgenticBar isOnline={$swarmStore.isOnline} on:submit={handleQuery} />
    </div>

    <!-- Lumina New Tab Experience -->
    {#if $activeTab?.url === "bucks://newtab" || !$activeTab}
        <LuminaHomepage />
    {/if}
</main>

<BrowserView />
