<script lang="ts">
    import { ipfsStore, type IpfsAddResult } from '$lib/ipfsStore';
    import { browserStore } from '$lib/stores';
    import { errorMessage, formatBytes } from '$lib/format';
    import SendToDevicesButton from '$lib/devices/SendToDevicesButton.svelte';

    let textContent = $state('');
    let publishResult = $state<IpfsAddResult | null>(null);
    let uploadResult = $state<IpfsAddResult | null>(null);
    let uploadName = $state('');
    let publishName = $state('');

    /** Label for a published note when it is sent to other devices: its first line, as a .txt name. */
    function noteName(content: string): string {
        const first = content.split('\n', 1)[0].replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48).trim();
        return first ? `${first}.txt` : 'note.txt';
    }
    let isPublishing = $state(false);
    let isUploading = $state(false);
    let publishError = $state('');
    let uploadError = $state('');
    let isDragging = $state(false);
    let fileInput: HTMLInputElement;

    function openCid(cid: string) {
        browserStore.createTab(`ipfs://${cid}`);
    }

    async function handlePublish() {
        const content = textContent.trim();
        if (!content) return;
        isPublishing = true;
        publishError = '';
        publishResult = null;
        try {
            publishResult = await ipfsStore.publishText(content);
            publishName = noteName(content);
            textContent = '';
            await ipfsStore.listPins();
        } catch (e) {
            publishError = errorMessage(e);
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
            uploadName = file.name;
            await ipfsStore.listPins();
        } catch (e) {
            uploadError = errorMessage(e);
        } finally {
            isUploading = false;
        }
    }

    function onDrop(e: DragEvent) {
        e.preventDefault();
        isDragging = false;
        const file = e.dataTransfer?.files?.[0];
        if (file) void handleFileUpload(file);
    }
</script>

{#snippet resultBox(title: string, r: IpfsAddResult, name?: string)}
    <div class="rounded-xl border border-success/20 bg-success/5 p-3 space-y-1 text-xs">
        <div class="text-success-fg font-medium">✓ {title}</div>
        <div class="flex gap-2">
            <span class="text-fg-faint w-20 shrink-0">CID</span>
            <span class="font-mono text-fg-muted break-all">{r.cid}</span>
        </div>
        <div class="flex gap-2">
            <span class="text-fg-faint w-20 shrink-0">Size</span>
            <span class="text-fg-subtle">{formatBytes(r.size)}</span>
        </div>
        <div class="flex gap-2">
            <span class="text-fg-faint w-20 shrink-0">Link</span>
            <button onclick={() => openCid(r.cid)} class="font-mono text-accent-fg hover:text-accent-fg-strong underline-offset-2 hover:underline break-all text-left transition-colors">
                {r.ipfs_uri}
            </button>
        </div>
        <div class="pt-2">
            <SendToDevicesButton cid={r.cid} {name} size={r.size} />
        </div>
    </div>
{/snippet}

<section class="space-y-3">
    <h2 class="text-md font-medium text-fg-muted">Add file</h2>
    <div
        role="button"
        tabindex="0"
        aria-label="Add a file to IPFS"
        ondrop={onDrop}
        ondragover={(e) => { e.preventDefault(); isDragging = true; }}
        ondragleave={() => { isDragging = false; }}
        onclick={() => fileInput.click()}
        onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click()}
        class="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
               {isDragging ? 'border-accent/60 bg-accent/5' : 'border-line-strong hover:border-line-emphasis'}"
    >
        <p class="text-md text-fg-subtle">{isUploading ? 'Adding…' : 'Drop a file or click to select'}</p>
        <p class="text-xs text-fg-faint mt-1">Pinned automatically after adding</p>
    </div>
    <input
        bind:this={fileInput}
        type="file"
        class="hidden"
        onchange={(e) => {
            const input = e.target as HTMLInputElement;
            const f = input.files?.[0];
            if (f) void handleFileUpload(f);
            input.value = '';
        }}
    />
    {#if uploadError}<p class="text-xs text-danger-fg">{uploadError}</p>{/if}
    {#if uploadResult}{@render resultBox('Added', uploadResult, uploadName)}{/if}
</section>

<section class="space-y-3">
    <h2 class="text-md font-medium text-fg-muted">Publish text</h2>
    <textarea
        bind:value={textContent}
        placeholder="Enter text or JSON to publish to IPFS…"
        rows="4"
        aria-label="Text to publish"
        class="w-full bg-surface-1 border border-line-subtle rounded-xl px-4 py-3 text-md text-fg placeholder-fg-faint resize-none focus:outline-none focus:border-accent/40 transition-colors"
    ></textarea>
    <div class="flex items-center gap-3">
        <button
            onclick={handlePublish}
            disabled={isPublishing || !textContent.trim()}
            class="px-4 py-2 rounded-xl bg-accent/80 hover:bg-accent-emphasis-hover disabled:opacity-40 disabled:cursor-not-allowed text-md font-medium transition-colors"
        >
            {isPublishing ? 'Publishing…' : 'Publish to IPFS'}
        </button>
        {#if publishError}<span class="text-xs text-danger-fg">{publishError}</span>{/if}
    </div>
    {#if publishResult}{@render resultBox('Published', publishResult, publishName)}{/if}
</section>
