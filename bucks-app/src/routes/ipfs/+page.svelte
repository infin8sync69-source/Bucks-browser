<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { ipfsStore, type IpfsUploadResult } from '$lib/ipfsStore';
    import { browserStore } from '$lib/stores';

    let textContent = $state('');
    let catCid = $state('');
    let catResult = $state('');
    let catError = $state('');
    let pinInputCid = $state('');

    let publishResult = $state<(IpfsUploadResult & { status: string }) | null>(null);
    let uploadResult = $state<IpfsUploadResult | null>(null);

    let isPublishing = $state(false);
    let isUploading = $state(false);
    let isCatting = $state(false);
    let isPinning = $state(false);

    let publishError = $state('');
    let uploadError = $state('');
    let pinError = $state('');

    let fileInput: HTMLInputElement;
    let isDragging = $state(false);

    onMount(() => {
        ipfsStore.init();
        ipfsStore.listPins();
    });

    onDestroy(() => {
        ipfsStore.cleanup();
    });

    function stateColor(state: string | undefined) {
        if (state === 'ready') return 'bg-emerald-500';
        if (state === 'initializing') return 'bg-yellow-400 animate-pulse';
        if (state === 'error') return 'bg-red-500';
        return 'bg-zinc-500';
    }

    function stateLabel(state: string | undefined) {
        if (state === 'ready') return 'Online';
        if (state === 'initializing') return 'Starting…';
        if (state === 'error') return 'Error';
        return 'Idle';
    }

    function shortCid(cid: string) {
        return cid.length > 20 ? `${cid.slice(0, 8)}…${cid.slice(-6)}` : cid;
    }

    function openCid(cid: string) {
        browserStore.createTab(`ipfs://${cid}`);
    }

    async function handlePublish() {
        if (!textContent.trim()) return;
        isPublishing = true;
        publishError = '';
        publishResult = null;
        try {
            publishResult = await ipfsStore.publishText(textContent.trim());
            textContent = '';
            await ipfsStore.listPins();
        } catch (e: any) {
            publishError = e?.message ?? String(e);
        } finally {
            isPublishing = false;
        }
    }

    async function handleFileUpload(file: File) {
        isUploading = true;
        uploadError = '';
        uploadResult = null;
        try {
            uploadResult = await ipfsStore.uploadFile(file);
            await ipfsStore.listPins();
        } catch (e: any) {
            uploadError = e?.message ?? String(e);
        } finally {
            isUploading = false;
        }
    }

    async function handleCat() {
        const cid = catCid.trim().replace(/^ipfs:\/\//i, '');
        if (!cid) return;
        isCatting = true;
        catResult = '';
        catError = '';
        try {
            catResult = await ipfsStore.catCid(cid);
        } catch (e: any) {
            catError = e?.message ?? String(e);
        } finally {
            isCatting = false;
        }
    }

    async function handlePinAdd() {
        const cid = pinInputCid.trim();
        if (!cid) return;
        isPinning = true;
        pinError = '';
        try {
            await ipfsStore.pinCid(cid);
            pinInputCid = '';
        } catch (e: any) {
            pinError = e?.message ?? String(e);
        } finally {
            isPinning = false;
        }
    }

    function onDrop(e: DragEvent) {
        e.preventDefault();
        isDragging = false;
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFileUpload(file);
    }
</script>

<div class="min-h-screen bg-[#07070a] text-white px-6 py-8 space-y-8 max-w-3xl mx-auto">

    <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-2xl bg-blue-600/20 border border-blue-500/20 flex items-center justify-center text-lg">
            🌐
        </div>
        <div>
            <h1 class="text-xl font-semibold tracking-tight">IPFS</h1>
            <p class="text-xs text-zinc-500">InterPlanetary File System</p>
        </div>
    </div>

    <!-- Node status -->
    {#if $ipfsStore.status}
        {@const s = $ipfsStore.status}
        <div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 space-y-3">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-2 text-sm font-medium">
                    <span class="w-2 h-2 rounded-full {stateColor(s.state)}"></span>
                    Node {stateLabel(s.state)}
                </div>
                <button
                    onclick={() => ipfsStore.refreshStatus()}
                    class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    Refresh
                </button>
            </div>
            <p class="text-xs text-zinc-400">{s.message}</p>
            {#if $ipfsStore.nodeInfo}
                {@const info = $ipfsStore.nodeInfo}
                <div class="border-t border-white/5 pt-3 space-y-1">
                    <div class="flex gap-2 text-xs">
                        <span class="text-zinc-500 w-24 shrink-0">Peer ID</span>
                        <span class="font-mono text-zinc-300 break-all">{info.peer_id}</span>
                    </div>
                    <div class="flex gap-2 text-xs">
                        <span class="text-zinc-500 w-24 shrink-0">Version</span>
                        <span class="text-zinc-300">{info.agent_version}</span>
                    </div>
                    {#if info.addresses.length > 0}
                        <div class="flex gap-2 text-xs">
                            <span class="text-zinc-500 w-24 shrink-0">Addresses</span>
                            <div class="space-y-0.5">
                                {#each info.addresses.slice(0, 4) as addr}
                                    <div class="font-mono text-zinc-400">{addr}</div>
                                {/each}
                                {#if info.addresses.length > 4}
                                    <div class="text-zinc-600">+{info.addresses.length - 4} more</div>
                                {/if}
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    {:else}
        <div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 flex items-center gap-3 text-sm text-zinc-500">
            <span class="w-2 h-2 rounded-full bg-zinc-500 animate-pulse"></span>
            Connecting to IPFS node…
        </div>
    {/if}

    <!-- Publish text -->
    <section class="space-y-3">
        <h2 class="text-sm font-medium text-zinc-300">Publish Text</h2>
        <textarea
            bind:value={textContent}
            placeholder="Enter text or JSON to publish to IPFS…"
            rows="4"
            class="w-full bg-white/[0.03] border border-white/5 rounded-xl px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-blue-500/40 transition-colors"
        ></textarea>
        <div class="flex items-center gap-3">
            <button
                onclick={handlePublish}
                disabled={isPublishing || !textContent.trim()}
                class="px-4 py-2 rounded-xl bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium transition-colors"
            >
                {isPublishing ? 'Publishing…' : 'Publish to IPFS'}
            </button>
            {#if publishError}
                <span class="text-xs text-red-400">{publishError}</span>
            {/if}
        </div>
        {#if publishResult}
            <div class="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1 text-xs">
                <div class="text-emerald-400 font-medium">✓ Published</div>
                <div class="flex gap-2">
                    <span class="text-zinc-500 w-20 shrink-0">CID</span>
                    <span class="font-mono text-zinc-300 break-all">{publishResult.cid}</span>
                </div>
                <div class="flex gap-2">
                    <span class="text-zinc-500 w-20 shrink-0">URI</span>
                    <span class="font-mono text-zinc-400">{publishResult.ipfs_uri}</span>
                </div>
                <button
                    onclick={() => publishResult && openCid(publishResult.cid)}
                    class="mt-1 text-blue-400 hover:text-blue-300 transition-colors"
                >
                    Open in browser →
                </button>
            </div>
        {/if}
    </section>

    <!-- Upload file -->
    <section class="space-y-3">
        <h2 class="text-sm font-medium text-zinc-300">Upload File</h2>
        <div
            role="button"
            tabindex="0"
            ondrop={onDrop}
            ondragover={(e) => { e.preventDefault(); isDragging = true; }}
            ondragleave={() => { isDragging = false; }}
            onclick={() => fileInput.click()}
            onkeydown={(e) => e.key === 'Enter' && fileInput.click()}
            class="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
                   {isDragging ? 'border-blue-500/60 bg-blue-500/5' : 'border-white/10 hover:border-white/20'}"
        >
            <p class="text-sm text-zinc-400">{isUploading ? 'Uploading…' : 'Drop a file or click to select'}</p>
            <p class="text-xs text-zinc-600 mt-1">Pinned automatically after upload</p>
        </div>
        <input
            bind:this={fileInput}
            type="file"
            class="hidden"
            onchange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) handleFileUpload(f); }}
        />
        {#if uploadError}<p class="text-xs text-red-400">{uploadError}</p>{/if}
        {#if uploadResult}
            <div class="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1 text-xs">
                <div class="text-emerald-400 font-medium">✓ Uploaded</div>
                <div class="flex gap-2">
                    <span class="text-zinc-500 w-20 shrink-0">CID</span>
                    <span class="font-mono text-zinc-300 break-all">{uploadResult.cid}</span>
                </div>
                <button
                    onclick={() => uploadResult && openCid(uploadResult.cid)}
                    class="mt-1 text-blue-400 hover:text-blue-300 transition-colors"
                >
                    Open in browser →
                </button>
            </div>
        {/if}
    </section>

    <!-- Retrieve content -->
    <section class="space-y-3">
        <h2 class="text-sm font-medium text-zinc-300">Retrieve Content</h2>
        <div class="flex gap-2">
            <input
                bind:value={catCid}
                placeholder="CID or ipfs://… path"
                class="flex-1 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/40 transition-colors font-mono"
            />
            <button
                onclick={handleCat}
                disabled={isCatting || !catCid.trim()}
                class="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm transition-colors"
            >
                {isCatting ? '…' : 'Fetch'}
            </button>
            <button
                onclick={() => { const c = catCid.trim().replace(/^ipfs:\/\//i, ''); if (c) openCid(c); }}
                disabled={!catCid.trim()}
                class="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm transition-colors"
            >
                Open
            </button>
        </div>
        {#if catError}<p class="text-xs text-red-400">{catError}</p>{/if}
        {#if catResult}
            <pre class="rounded-xl bg-white/[0.03] border border-white/5 p-4 text-xs text-zinc-300 overflow-auto max-h-48 whitespace-pre-wrap break-all">{catResult}</pre>
        {/if}
    </section>

    <!-- Pin by CID -->
    <section class="space-y-3">
        <h2 class="text-sm font-medium text-zinc-300">Pin a CID</h2>
        <div class="flex gap-2">
            <input
                bind:value={pinInputCid}
                placeholder="Qm… or bafy…"
                class="flex-1 bg-white/[0.03] border border-white/5 rounded-xl px-4 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500/40 transition-colors font-mono"
            />
            <button
                onclick={handlePinAdd}
                disabled={isPinning || !pinInputCid.trim()}
                class="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-sm transition-colors"
            >
                {isPinning ? 'Pinning…' : 'Pin'}
            </button>
        </div>
        {#if pinError}<p class="text-xs text-red-400">{pinError}</p>{/if}
    </section>

    <!-- Pinned content list -->
    <section class="space-y-3">
        <div class="flex items-center justify-between">
            <h2 class="text-sm font-medium text-zinc-300">
                Pinned Content
                {#if $ipfsStore.pins.length > 0}
                    <span class="ml-1.5 text-zinc-600">({$ipfsStore.pins.length})</span>
                {/if}
            </h2>
            <button
                onclick={() => ipfsStore.listPins()}
                class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
                {$ipfsStore.isLoadingPins ? 'Loading…' : 'Refresh'}
            </button>
        </div>
        {#if $ipfsStore.isLoadingPins && $ipfsStore.pins.length === 0}
            <div class="text-xs text-zinc-600 py-4 text-center">Loading pins…</div>
        {:else if $ipfsStore.pins.length === 0}
            <div class="text-xs text-zinc-600 py-4 text-center rounded-xl border border-white/5">No pinned content yet</div>
        {:else}
            <div class="rounded-2xl border border-white/5 overflow-hidden divide-y divide-white/[0.04]">
                {#each $ipfsStore.pins as pin (pin.cid)}
                    <div class="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors group">
                        <div class="flex items-center gap-3 min-w-0">
                            <span class="w-1.5 h-1.5 rounded-full bg-blue-500/60 shrink-0"></span>
                            <span class="font-mono text-xs text-zinc-300 truncate">{shortCid(pin.cid)}</span>
                            <span class="text-xs text-zinc-600">{pin.pin_type}</span>
                        </div>
                        <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onclick={() => openCid(pin.cid)} class="text-xs text-blue-400 hover:text-blue-300 transition-colors">Open</button>
                            <button onclick={() => ipfsStore.unpinCid(pin.cid)} class="text-xs text-red-400/70 hover:text-red-400 transition-colors">Unpin</button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    </section>
</div>
