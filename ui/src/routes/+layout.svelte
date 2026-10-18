<script lang="ts">
    import '../app.css';
    import SwarmCanvas from '$lib/SwarmCanvas.svelte';
    import Header from '$lib/Header.svelte';
    import ContentArea from '$lib/ContentArea.svelte';
    import AgenticBar from '$lib/AgenticBar.svelte';
    import ChatPanel from '$lib/ChatPanel.svelte';
    import EphemeralWidget from '$lib/EphemeralWidget.svelte';
    import LuminaHomepage from '$lib/LuminaHomepage.svelte';
    import FindBar from '$lib/FindBar.svelte';
    import { browserStore, activeTab } from '$lib/stores';
    import { ipfsStore } from '$lib/ipfsStore';
    import { settingsStore } from '$lib/settingsStore';
    import { swarmStore } from '$lib/swarmStore';
    import { chatOpen } from '$lib/uiState';
    import { bucks } from '$lib/bridge';
    import { onMount } from 'svelte';

    let { children } = $props();

    onMount(() => {
        void settingsStore.init();
        ipfsStore.init();
        const teardownTabs = browserStore.init();
        void swarmStore.checkOnline();
        const statusPoll = setInterval(() => void swarmStore.checkOnline(), 30_000);
        // The Soul Engine becomes usable on its own schedule (model download, warm-up): follow it.
        let lastSoulState = '';
        const stopSoulWatch = bucks.agent.onSoulStatus((st) => {
            if (st.state === lastSoulState) return;
            lastSoulState = st.state;
            if ($settingsStore?.agent.provider === 'soul') void swarmStore.checkOnline();
        });
        return () => {
            clearInterval(statusPoll);
            stopSoulWatch();
            teardownTabs();
            ipfsStore.cleanup();
            settingsStore.destroy();
        };
    });

    // The agent provider / URL / model can change in Settings: re-read the agent status.
    let lastAgentKey = '';
    $effect(() => {
        const a = $settingsStore?.agent;
        if (!a) return;
        const key = `${a.provider}|${a.remoteUrl}|${a.ollamaUrl}|${a.ollamaModel}`;
        if (key === lastAgentKey) return;
        const first = lastAgentKey === '';
        lastAgentKey = key;
        if (!first) void swarmStore.checkOnline();
    });

    function handleQuery(query: string) {
        chatOpen.set(true);
        void swarmStore.sendQuery(query);
    }

    // Auto-open panel when agent responds
    $effect(() => {
        if ($swarmStore.messages.length > 0) chatOpen.set(true);
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

<!-- Layer 2: Placeholder for the native web view of the active external tab (z-0, top 96px → bottom 88px) -->
<ContentArea />

<!-- Find in page (Ctrl/Cmd+F); the content area moves down while it is open -->
<FindBar />

<!-- New-tab home screen (z-0) -->
{#if $activeTab?.url === 'bucks://newtab' || !$activeTab}
    <LuminaHomepage />
{/if}

<!-- Layer 3: Internal route content (z-10, below all overlays) -->
<div class="fixed left-0 right-0 top-24 bottom-[88px] z-10 overflow-y-auto pointer-events-auto bg-[#07070a]"
     style="display: {($activeTab?.type === 'internal' || $activeTab?.type === 'newtab') && $activeTab?.url !== 'bucks://newtab' ? 'block' : 'none'}">
    {@render children()}
</div>

<!-- Layer 4: Command dock — AgenticBar lives in the reserved bottom band (z-[200]) -->
<!-- Shifts left when the chat panel is open so it never hides under the panel -->
<div class="fixed bottom-0 z-[200] h-[88px] flex items-end justify-center pb-4 pointer-events-none transition-all duration-300 ease-out
            {$chatOpen ? 'left-0 right-[448px] px-4' : 'left-1/2 -translate-x-1/2 w-full max-w-2xl px-4'}">
    <div class="w-full pointer-events-auto">
        <AgenticBar
            isOnline={$swarmStore.isOnline}
            slmReady={$swarmStore.slmReady}
            model={$swarmStore.model}
            chatOpen={$chatOpen}
            onsubmit={handleQuery}
            onopenchat={() => chatOpen.set(true)}
        />
    </div>
</div>

<!-- Layer 5: Chat panel — right-side drawer (z-[300]) -->
{#if $chatOpen}
    <ChatPanel
        isOnline={$swarmStore.isOnline}
        slmReady={$swarmStore.slmReady}
        model={$swarmStore.model}
        onclose={() => chatOpen.set(false)}
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
