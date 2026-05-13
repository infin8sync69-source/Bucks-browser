<script lang="ts">
    import '../app.css';
    import SwarmCanvas from '$lib/SwarmCanvas.svelte';
    import Header from '$lib/Header.svelte';
    import BrowserView from '$lib/BrowserView.svelte';
    import AgenticBar from '$lib/AgenticBar.svelte';
    import ChatPanel from '$lib/ChatPanel.svelte';
    import EphemeralWidget from '$lib/EphemeralWidget.svelte';
    import LuminaHomepage from '$lib/LuminaHomepage.svelte';
    import { activeTab } from '$lib/stores';
    import { swarmStore } from '$lib/swarmStore';
    import { isSwarmThinking } from '$lib/stores';
    import { onMount } from 'svelte';

    let { children } = $props();

    let chatOpen = $state(false);

    onMount(() => {
        swarmStore.checkOnline();
        const slmPoll = setInterval(() => swarmStore.checkSlmReady(), 30_000);
        return () => clearInterval(slmPoll);
    });

    function handleQuery(query: string) {
        chatOpen = true;
        swarmStore.sendQuery(query);
    }

    // Auto-open panel when agent responds
    $effect(() => {
        if ($swarmStore.messages.length > 0) chatOpen = true;
    });

    // Only show EphemeralWidget for non-text action types
    const actionWidget = $derived(
        $swarmStore.activeWidget?.a2ui && $swarmStore.activeWidget.a2ui.type !== 'text'
            ? $swarmStore.activeWidget
            : null
    );
</script>

<!-- Layer 0: Animated background canvas -->
<SwarmCanvas />

<!-- Layer 1: Persistent top chrome (z-[110]) -->
<Header />

<!-- Layer 2: Persistent iframe layer (z-0) -->
<BrowserView />

<!-- New-tab home screen (z-0) -->
{#if $activeTab?.url === 'bucks://newtab' || !$activeTab}
    <LuminaHomepage />
{/if}

<!-- Layer 3: Internal route content (z-10, below all overlays) -->
<div class="fixed inset-0 top-[5.5rem] z-10 overflow-y-auto pointer-events-auto bg-[#07070a]"
     style="display: {($activeTab?.type === 'internal' || $activeTab?.type === 'newtab') && $activeTab?.url !== 'bucks://newtab' ? 'block' : 'none'}">
    {@render children()}
</div>

<!-- Layer 4: Command dock — AgenticBar (z-[200]) -->
<!-- Shifts left when chat panel is open so it never hides under the panel -->
<div class="fixed z-[200] bottom-6 pointer-events-none transition-all duration-300 ease-out
            {chatOpen ? 'left-0 right-[448px] px-4' : 'left-1/2 -translate-x-1/2 w-full max-w-2xl px-4'}">
    <div class="pointer-events-auto">
        <AgenticBar
            isOnline={$swarmStore.isOnline}
            slmReady={$swarmStore.slmReady}
            chatOpen={chatOpen}
            onsubmit={handleQuery}
            onopenchat={() => { chatOpen = true; }}
        />
    </div>
</div>

<!-- Layer 5: Chat panel — right-side drawer (z-[300]) -->
{#if chatOpen}
    <ChatPanel
        isOnline={$swarmStore.isOnline}
        slmReady={$swarmStore.slmReady}
        onclose={() => { chatOpen = false; }}
    />
{/if}

<!-- Layer 6: Ephemeral action modal — center spotlight (z-[498/499]) -->
<!-- Has its own backdrop; always above everything else -->
{#if actionWidget}
    <EphemeralWidget
        {...actionWidget.a2ui || {}}
        description={actionWidget.content}
        cid={actionWidget.cid}
        taskId={actionWidget.taskId}
        onclose={swarmStore.closeWidget}
    />
{/if}
