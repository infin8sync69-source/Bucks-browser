<script lang="ts">
    import '../app.css';
    import SwarmCanvas from '$lib/SwarmCanvas.svelte';
    import Header from '$lib/Header.svelte';
    import BrowserView from '$lib/BrowserView.svelte';
    import AgenticBar from '$lib/AgenticBar.svelte';
    import EphemeralWidget from '$lib/EphemeralWidget.svelte';
    import LuminaHomepage from '$lib/LuminaHomepage.svelte';
    import { activeTab } from '$lib/stores';
    import { swarmStore } from '$lib/swarmStore';
    import { onMount } from 'svelte';

    let { children } = $props();

    onMount(() => { swarmStore.checkOnline(); });

    function handleQuery(query: string) { swarmStore.sendQuery(query); }
</script>

<!-- Background canvas -->
<SwarmCanvas />

<!-- Persistent top chrome — renders on every route -->
<Header />

<!-- Persistent iframe layer — keeps external tabs alive across internal navigation -->
<BrowserView />

<!-- New-tab home screen — only when active tab is newtab -->
{#if $activeTab?.url === 'bucks://newtab' || !$activeTab}
    <LuminaHomepage />
{/if}

<!-- Internal page content (settings, bookmarks, history, login, etc.)
     Sits at z-10 above BrowserView (z-0), scrollable, below header (~80px from top) -->
<div class="fixed inset-0 top-[5.5rem] z-10 overflow-y-auto pointer-events-auto bg-[#07070a]"
     style="display: {($activeTab?.type === 'internal' || $activeTab?.type === 'newtab') && $activeTab?.url !== 'bucks://newtab' ? 'block' : 'none'}">
    {@render children()}
</div>

<!-- Overlays — always above everything else -->
<main class="fixed inset-0 z-[200] pointer-events-none">
    {#if $swarmStore.activeWidget}
        <div class="pointer-events-auto">
            <EphemeralWidget
                {...$swarmStore.activeWidget.a2ui || {}}
                description={$swarmStore.activeWidget.content}
                cid={$swarmStore.activeWidget.cid}
                taskId={$swarmStore.activeWidget.taskId}
                onclose={swarmStore.closeWidget}
            />
        </div>
    {/if}
    <div class="pointer-events-auto">
        <AgenticBar isOnline={$swarmStore.isOnline} onsubmit={handleQuery} />
    </div>
</main>
