<script lang="ts">
    import { onMount } from "svelte";
    import { browserStore, activeTab } from "$lib/stores";
    import { ipfsStore } from "$lib/ipfsStore";
    import IpfsViewer from "$lib/IpfsViewer.svelte";

    // In Tauri, true cross-origin webviews require the Tauri webview plugin or OS-level windows.
    // We are using iframes for the UI shell prototype until the backend bridge is wired.

    // Gateway URL: respect the user's setting from bucks://settings.
    // "local" (default) → use the embedded Kubo node if ready, else ipfs.io fallback.
    // Any other value → use the public gateway they chose, ignoring local node state.
    const GATEWAY_URLS: Record<string, string> = {
        "ipfs.io": "https://ipfs.io/ipfs/",
        "cf":      "https://cloudflare-ipfs.com/ipfs/",
    };
    const _gwPref = $derived(
        typeof localStorage !== "undefined"
            ? localStorage.getItem("bucks_ipfs_gateway") ?? "local"
            : "local"
    );
    let ipfsGatewayBase = $derived(
        _gwPref !== "local"
            ? (GATEWAY_URLS[_gwPref] ?? "https://ipfs.io/ipfs/")
            : ($ipfsStore.status?.gateway_url ?? "https://ipfs.io/ipfs/")
    );

    onMount(() => {
        ipfsStore.init();
    });

    function shortCid(cid: string) {
        return cid.length > 16 ? `${cid.slice(0, 8)}…${cid.slice(-6)}` : cid;
    }

    function ipfsTitle(url: string): string {
        const cid = url.replace(/^ipfs:\/\//i, "").replace(/^\/ipfs\//i, "").split("/")[0];
        return cid ? `IPFS: ${shortCid(cid)}` : "IPFS";
    }

    function ipnsTitle(url: string): string {
        const name = url.replace(/^ipns:\/\//i, "").replace(/^\/ipns\//i, "").split("/")[0];
        return name ? `IPNS: ${name.length > 20 ? name.slice(0, 16) + "…" : name}` : "IPNS";
    }

    function handleIframeLoad(e: Event, tab: { id: string; url: string }) {
        const iframe = e.currentTarget as HTMLIFrameElement;
        let title = "";
        let newUrl  = "";

        try {
            // Same-origin only (e.g. local IPFS gateway on 127.0.0.1)
            title  = iframe.contentDocument?.title || "";
            newUrl = iframe.contentWindow?.location.href || "";
        } catch { /* cross-origin — can't read title or URL */ }

        // Normalise URL: ignore about:blank, strip trailing slash noise
        if (newUrl && newUrl !== "about:blank" && newUrl !== tab.url) {
            // Map gateway URL back to ipfs:// for display
            const gwBase = $ipfsStore.status?.gateway_url;
            if (gwBase && newUrl.startsWith(gwBase)) {
                newUrl = "ipfs://" + newUrl.slice(gwBase.length);
            }
        } else {
            newUrl = tab.url;
        }

        if (!title) {
            if (/^ipfs:\/\//i.test(newUrl)) title = ipfsTitle(newUrl);
            else if (/^ipns:\/\//i.test(newUrl)) title = ipnsTitle(newUrl);
            else { try { title = new URL(newUrl).hostname; } catch { title = newUrl; } }
        }

        browserStore.updateTab(tab.id, { title, url: newUrl, isLoading: false });
    }

    function toIframeSrc(url: string): string {
        if (/^ipfs:\/\//i.test(url)) {
            const stripped = url.replace(/^ipfs:\/\//i, "");
            if (!stripped) return ipfsGatewayBase;
            if (stripped.startsWith("ipfs/")) return `${ipfsGatewayBase}${stripped.slice(5)}`;
            if (stripped.startsWith("/ipfs/")) return `${ipfsGatewayBase}${stripped.slice(6)}`;
            return `${ipfsGatewayBase}${stripped}`;
        }

        if (/^ipns:\/\//i.test(url)) {
            const stripped = url.replace(/^ipns:\/\//i, "");
            const gatewayRoot = ipfsGatewayBase.replace(/\/ipfs\/?$/i, "/ipns/");
            if (!stripped) return gatewayRoot;
            if (stripped.startsWith("ipns/")) return `${gatewayRoot}${stripped.slice(5)}`;
            if (stripped.startsWith("/ipns/")) return `${gatewayRoot}${stripped.slice(6)}`;
            return `${gatewayRoot}${stripped}`;
        }

        return url;
    }
</script>

{#if $browserStore.tabs.some((t) => t.type === "external")}
    <div class="fixed inset-0 top-16 z-0 bg-[#0a0a0c]">
        {#each $browserStore.tabs.filter((t) => t.type === "external") as tab (tab.id)}
            <div
                class="absolute inset-0 transition-opacity duration-300"
                style="opacity:{tab.active ? 1 : 0}; pointer-events:{tab.active ? 'auto' : 'none'}; z-index:{tab.active ? 10 : 0}; visibility:{tab.active ? 'visible' : 'hidden'};"
            >
                <!-- loading shimmer shown until iframe fires onload -->
                {#if tab.isLoading}
                    <div class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#0a0a0c] gap-3">
                        <div class="w-8 h-8 rounded-full border-2 border-white/10 border-t-blue-500 animate-spin"></div>
                        <span class="text-xs text-zinc-500 font-mono truncate max-w-xs">
                            {tab.url.length > 50 ? tab.url.slice(0, 24) + "…" + tab.url.slice(-16) : tab.url}
                        </span>
                    </div>
                {/if}

                {#if /^ipfs:\/\//i.test(tab.url) || /^ipns:\/\//i.test(tab.url)}
                    <IpfsViewer tabId={tab.id} url={tab.url} />
                {:else}
                    <iframe
                        src={toIframeSrc(tab.url)}
                        title={tab.title}
                        onload={(e) => handleIframeLoad(e, tab)}
                        class="absolute inset-0 w-full h-full border-none bg-white"
                        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                    ></iframe>
                {/if}
            </div>
        {/each}
    </div>
{/if}
