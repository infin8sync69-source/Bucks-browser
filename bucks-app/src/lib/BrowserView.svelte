<script lang="ts">
    import { browserStore, activeTab } from "$lib/stores";

    // In Tauri, true cross-origin webviews require the Tauri webview plugin or OS-level windows.
    // We are using iframes for the UI shell prototype until the backend bridge is wired.
</script>

{#if $browserStore.tabs.some((t) => t.type === "external")}
    <div class="fixed inset-0 top-16 z-0 bg-white shadow-inner">
        {#each $browserStore.tabs.filter((t) => t.type === "external") as tab (tab.id)}
            <iframe
                src={tab.url}
                title={tab.title}
                class="absolute inset-0 w-full h-full border-none bg-white transition-opacity duration-300"
                style="
                opacity: {tab.active ? 1 : 0}; 
                pointer-events: {tab.active ? 'auto' : 'none'}; 
                z-index: {tab.active ? 10 : 0};
                visibility: {tab.active || tab.isAgentTab
                    ? 'visible'
                    : 'hidden'};
            "
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
            ></iframe>
        {/each}
    </div>
{/if}
