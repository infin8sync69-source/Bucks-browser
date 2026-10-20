<script lang="ts">
    import { onMount } from 'svelte';
    import { ipfsStore } from '$lib/ipfsStore';
    import NodeStatusCard from '$lib/ipfs/NodeStatusCard.svelte';
    import AddContent from '$lib/ipfs/AddContent.svelte';
    import PathBrowser from '$lib/ipfs/PathBrowser.svelte';
    import PinList from '$lib/ipfs/PinList.svelte';
    import DevicesSection from '$lib/devices/DevicesSection.svelte';
    import { devicesStore } from '$lib/devicesStore';

    onMount(() => {
        ipfsStore.init();
        devicesStore.init();
        void ipfsStore.listPins();
        return () => devicesStore.cleanup();
    });

    // Pins can only be listed once the node is up; reload them when it becomes ready.
    let lastState: string | undefined;
    $effect(() => {
        const state = $ipfsStore.status?.state;
        if (state === 'ready' && lastState !== 'ready') void ipfsStore.listPins();
        lastState = state;
    });
</script>

<div class="min-h-full bg-canvas text-fg px-6 py-8 space-y-8 max-w-3xl mx-auto">
    <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl bg-accent/20 border border-accent/20 flex items-center justify-center text-lg">
            🌐
        </div>
        <div>
            <h1 class="text-xl font-semibold tracking-tight">IPFS</h1>
            <p class="text-xs text-fg-faint">InterPlanetary File System</p>
        </div>
    </div>

    <NodeStatusCard />
    <DevicesSection />
    <AddContent />
    <PathBrowser />
    <PinList />
</div>
