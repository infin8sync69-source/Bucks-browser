<script lang="ts">
    import { invoke } from '@tauri-apps/api/core';
    import { ipfsStore } from '$lib/ipfsStore';
    import { browserStore } from '$lib/stores';

    let { tabId, url }: { tabId: string; url: string } = $props();

    type Kind = 'loading' | 'error' | 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'html' | 'directory' | 'binary';

    interface DirEntry { name: string; cid: string; size: number; is_dir: boolean; }

    let kind        = $state<Kind>('loading');
    let gatewaySrc  = $state('');
    let mimeType    = $state('');
    let fileSize    = $state(0);
    let textContent = $state('');
    let dirEntries  = $state<DirEntry[]>([]);
    let errorMsg    = $state('');
    let zoom        = $state(1);
    let copied      = $state(false);
    let rootCid     = $state('');

    let gatewayBase = $derived($ipfsStore.status?.gateway_url ?? 'https://ipfs.io/ipfs/');

    $effect(() => { if (url) detect(url); });

    async function detect(u: string) {
        kind = 'loading'; errorMsg = ''; textContent = ''; dirEntries = [];
        const cidPath = u.replace(/^ipfs:\/\//i, '').replace(/^\/ipfs\//i, '');
        rootCid = cidPath.split('/')[0];
        gatewaySrc = `${gatewayBase}${cidPath}`;

        try {
            // 1. Try directory listing
            const entries = await invoke<DirEntry[]>('ipfs_ls', { cid: rootCid });
            if (entries.length > 0) {
                dirEntries = entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
                kind = 'directory';
                browserStore.updateTab(tabId, { title: `${shortCid(rootCid)}`, isLoading: false });
                return;
            }
        } catch { /* not a directory */ }

        // 2. HEAD to get content-type
        try {
            const res = await fetch(gatewaySrc, { method: 'HEAD' });
            const ct = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
            const cl = res.headers.get('content-length');
            mimeType = ct;
            if (cl) fileSize = parseInt(cl);

            if (ct.startsWith('image/')) {
                kind = 'image';
            } else if (ct === 'application/pdf') {
                kind = 'pdf';
            } else if (ct.startsWith('video/')) {
                kind = 'video';
            } else if (ct.startsWith('audio/')) {
                kind = 'audio';
            } else if (ct === 'text/html') {
                kind = 'html';
            } else if (ct.startsWith('text/') || ['application/json','application/javascript','application/xml'].includes(ct)) {
                kind = 'text';
                try {
                    const b64 = await invoke<string>('ipfs_cat', { cid: rootCid });
                    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    textContent = new TextDecoder().decode(bytes);
                } catch { textContent = '(Could not load text content)'; }
            } else {
                kind = 'binary';
            }
            browserStore.updateTab(tabId, { title: kindTitle(), isLoading: false });
        } catch (e: any) {
            kind = 'error'; errorMsg = e?.message ?? String(e);
        }
    }

    function kindTitle(): string {
        const s = shortCid(rootCid);
        if (kind === 'image') return `🖼 ${s}`;
        if (kind === 'pdf') return `📄 ${s}`;
        if (kind === 'video') return `🎬 ${s}`;
        if (kind === 'audio') return `🎵 ${s}`;
        if (kind === 'text') return `📝 ${s}`;
        return s;
    }

    function shortCid(c: string) {
        return c.length > 20 ? `${c.slice(0, 10)}…${c.slice(-6)}` : c;
    }

    function fmtSize(b: number): string {
        if (!b) return '';
        if (b < 1024) return `${b} B`;
        if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
        return `${(b / 1024 ** 2).toFixed(1)} MB`;
    }

    function fileIcon(e: DirEntry): string {
        if (e.is_dir) return '📁';
        const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
        const m: Record<string,string> = {
            pdf:'📄', png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼', webp:'🖼', svg:'🖼', ico:'🖼',
            mp4:'🎬', webm:'🎬', mov:'🎬', avi:'🎬', mkv:'🎬',
            mp3:'🎵', wav:'🎵', ogg:'🎵', flac:'🎵', aac:'🎵',
            txt:'📝', md:'📝', json:'📋', js:'📋', ts:'📋', py:'📋', rs:'📋',
            html:'🌐', htm:'🌐', css:'🎨', xml:'📋',
            zip:'📦', tar:'📦', gz:'📦', rar:'📦', '7z':'📦',
            doc:'📄', docx:'📄', xls:'📊', xlsx:'📊', csv:'📊', ppt:'📊',
        };
        return m[ext] ?? '📄';
    }

    function openEntry(e: DirEntry) {
        browserStore.navigateActiveTab(`ipfs://${e.cid}`);
    }

    async function copyText(t: string) {
        await navigator.clipboard.writeText(t).catch(() => {});
        copied = true; setTimeout(() => copied = false, 2000);
    }

    function downloadUrl() { return gatewaySrc + '?download=true'; }
</script>

<div class="flex flex-col h-full bg-[#0a0a0c] text-white overflow-hidden">

    <!-- Top info bar -->
    <div class="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-white/5 bg-black/30 backdrop-blur">
        <span class="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/[0.04] font-mono text-zinc-400 uppercase tracking-wide">
            {kind === 'loading' ? '…' : kind === 'directory' ? 'dir' : mimeType.split('/')[1] || kind}
        </span>
        <span class="font-mono text-xs text-zinc-400 truncate flex-1">{rootCid}</span>
        {#if fileSize > 0}
            <span class="text-xs text-zinc-600">{fmtSize(fileSize)}</span>
        {/if}
        <button
            onclick={() => copyText(`ipfs://${rootCid}`)}
            class="text-xs px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-white/10 transition-colors text-zinc-400 hover:text-white"
        >
            {copied ? '✓ Copied' : 'Copy URI'}
        </button>
        {#if kind !== 'loading' && kind !== 'error' && kind !== 'directory'}
            <a href={downloadUrl()} download class="text-xs px-2 py-1 rounded-lg bg-white/[0.05] hover:bg-white/10 transition-colors text-zinc-400 hover:text-white">
                ↓ Save
            </a>
        {/if}
    </div>

    <!-- Content area -->
    <div class="flex-1 overflow-auto relative">

        <!-- Loading -->
        {#if kind === 'loading'}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div class="w-8 h-8 rounded-full border-2 border-white/10 border-t-blue-500 animate-spin"></div>
                <p class="text-xs text-zinc-500 font-mono">{shortCid(rootCid)}</p>
            </div>

        <!-- Error -->
        {:else if kind === 'error'}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8">
                <span class="text-3xl">⚠️</span>
                <p class="text-sm text-red-400 text-center">{errorMsg}</p>
                <button onclick={() => detect(url)} class="text-xs px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 transition-colors">Retry</button>
            </div>

        <!-- Image -->
        {:else if kind === 'image'}
            <div class="absolute inset-0 flex flex-col items-center justify-center bg-[#060608] gap-3 p-4">
                <img
                    src={gatewaySrc}
                    alt={rootCid}
                    style="max-width:100%; max-height:calc(100% - 48px); transform:scale({zoom}); transform-origin:center; transition:transform 0.2s; border-radius:8px;"
                    class="object-contain shadow-2xl"
                />
                <div class="flex items-center gap-2">
                    <button onclick={() => zoom = Math.max(0.25, zoom - 0.25)} class="w-8 h-8 rounded-xl bg-white/[0.08] hover:bg-white/15 flex items-center justify-center text-sm transition-colors">−</button>
                    <span class="text-xs text-zinc-500 w-14 text-center">{Math.round(zoom * 100)}%</span>
                    <button onclick={() => zoom = Math.min(4, zoom + 0.25)} class="w-8 h-8 rounded-xl bg-white/[0.08] hover:bg-white/15 flex items-center justify-center text-sm transition-colors">+</button>
                    <button onclick={() => zoom = 1} class="text-xs px-3 py-1 rounded-xl bg-white/[0.08] hover:bg-white/15 transition-colors">Reset</button>
                </div>
            </div>

        <!-- PDF -->
        {:else if kind === 'pdf'}
            <embed src={gatewaySrc} type="application/pdf" class="absolute inset-0 w-full h-full" />

        <!-- Video -->
        {:else if kind === 'video'}
            <div class="absolute inset-0 flex items-center justify-center bg-black p-4">
                <!-- svelte-ignore a11y_media_has_caption -->
                <video src={gatewaySrc} controls class="max-w-full max-h-full rounded-xl shadow-2xl" style="max-height:calc(100% - 2rem)">
                    Your browser does not support video playback.
                </video>
            </div>

        <!-- Audio -->
        {:else if kind === 'audio'}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8">
                <div class="w-32 h-32 rounded-3xl bg-white/[0.05] border border-white/10 flex items-center justify-center text-5xl shadow-2xl">🎵</div>
                <audio src={gatewaySrc} controls class="w-full max-w-md rounded-xl">
                    Your browser does not support audio playback.
                </audio>
                <p class="text-xs text-zinc-600 font-mono">{mimeType}</p>
            </div>

        <!-- Text / Code -->
        {:else if kind === 'text'}
            <div class="p-4 h-full">
                <pre class="font-mono text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap break-all overflow-auto h-full bg-black/20 rounded-xl p-4 border border-white/5">{textContent}</pre>
            </div>

        <!-- HTML → iframe -->
        {:else if kind === 'html'}
            <iframe
                src={gatewaySrc}
                title={rootCid}
                class="absolute inset-0 w-full h-full border-none bg-white"
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            ></iframe>

        <!-- Directory -->
        {:else if kind === 'directory'}
            <div class="p-4 max-w-3xl mx-auto space-y-2">
                <div class="flex items-center gap-2 mb-4">
                    <span class="text-lg">📁</span>
                    <span class="font-mono text-sm text-zinc-300">{rootCid}</span>
                    <span class="text-xs text-zinc-600 ml-auto">{dirEntries.length} items</span>
                </div>
                <div class="rounded-2xl border border-white/5 overflow-hidden divide-y divide-white/[0.04]">
                    {#each dirEntries as entry (entry.cid)}
                        <button
                            onclick={() => openEntry(entry)}
                            class="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.04] transition-colors text-left group"
                        >
                            <span class="text-base shrink-0">{fileIcon(entry)}</span>
                            <span class="flex-1 text-sm text-zinc-200 truncate font-medium group-hover:text-white">{entry.name || shortCid(entry.cid)}</span>
                            <span class="text-xs text-zinc-600 shrink-0">{fmtSize(entry.size)}</span>
                            <span class="text-xs text-zinc-700 font-mono shrink-0 hidden group-hover:block">{shortCid(entry.cid)}</span>
                            <span class="text-zinc-600 text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                        </button>
                    {/each}
                </div>
            </div>

        <!-- Binary / unknown -->
        {:else if kind === 'binary'}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-5 p-8">
                <div class="w-24 h-24 rounded-3xl bg-white/[0.04] border border-white/10 flex items-center justify-center text-4xl">📦</div>
                <div class="text-center space-y-1">
                    <p class="text-sm font-medium text-zinc-300">Binary file</p>
                    <p class="text-xs text-zinc-600">{mimeType} {fileSize ? '· ' + fmtSize(fileSize) : ''}</p>
                </div>
                <a href={downloadUrl()} download class="px-5 py-2 rounded-xl bg-blue-600/80 hover:bg-blue-600 transition-colors text-sm font-medium">
                    ↓ Download
                </a>
            </div>
        {/if}
    </div>
</div>
