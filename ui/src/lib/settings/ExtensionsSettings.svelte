<script lang="ts">
    // Settings → Extensions: unpacked Chrome extensions loaded from the profile's extensions folder.
    import { onMount } from "svelte";
    import { FolderOpen, RefreshCw, Puzzle } from "lucide-svelte";
    import { bucks, type ExtensionInfo } from "$lib/bridge";
    import { errorMessage } from "$lib/format";

    let folder = $state("");
    let extensions = $state<ExtensionInfo[]>([]);
    let busy = $state(false);
    let message = $state("");

    async function apply(p: Promise<{ folder: string; extensions: ExtensionInfo[] }>) {
        busy = true;
        message = "";
        try {
            const r = await p;
            folder = r.folder;
            extensions = r.extensions;
        } catch (e) {
            message = errorMessage(e);
        } finally {
            busy = false;
        }
    }

    onMount(() => void apply(bucks.extensions.list()));
</script>

<div class="space-y-2">
    <p class="text-2xs text-fg-faint leading-relaxed">
        Put unpacked Chrome extensions (a folder with a <span class="font-mono">manifest.json</span>) in
        <span class="font-mono break-all text-fg-faint">{folder || "the extensions folder"}</span>, then reload.
        They run in web pages only. Content blockers and userscript managers work; toolbar buttons and popups are not shown.
    </p>
    {#each extensions as ext (ext.path)}
        <div class="flex items-center gap-3 p-3 rounded-2xl border border-line bg-surface-1">
            <Puzzle size={14} class={ext.error ? "text-danger-fg-strong/70" : "text-success-fg-strong/70"} />
            <div class="min-w-0">
                <p class="text-xs text-fg-muted truncate">{ext.name} <span class="text-fg-faint">{ext.version}</span></p>
                <p class="text-3xs {ext.error ? 'text-danger-fg-strong/70' : 'text-fg-faint'} truncate">{ext.error ?? ext.path}</p>
            </div>
        </div>
    {:else}
        <p class="text-2xs text-fg-faint px-1">No extensions installed.</p>
    {/each}
    <div class="flex items-center gap-2">
        <button onclick={() => bucks.extensions.openFolder().catch((e) => (message = errorMessage(e)))}
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-3 hover:bg-surface-4 text-xs text-fg-muted"><FolderOpen size={12} /> Open folder</button>
        <button onclick={() => apply(bucks.extensions.reload())} disabled={busy}
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-3 hover:bg-surface-4 disabled:opacity-40 text-xs text-fg-muted"><RefreshCw size={12} class={busy ? "animate-spin" : ""} /> Reload</button>
        {#if message}<span class="text-2xs text-danger-fg-strong/80">{message}</span>{/if}
    </div>
</div>
