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
    <p class="text-[11px] text-white/35 leading-relaxed">
        Put unpacked Chrome extensions (a folder with a <span class="font-mono">manifest.json</span>) in
        <span class="font-mono break-all text-white/50">{folder || "the extensions folder"}</span>, then reload.
        They run in web pages only. Content blockers and userscript managers work; toolbar buttons and popups are not shown.
    </p>
    {#each extensions as ext (ext.path)}
        <div class="flex items-center gap-3 p-3 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            <Puzzle size={14} class={ext.error ? "text-red-300/70" : "text-emerald-300/70"} />
            <div class="min-w-0">
                <p class="text-[12px] text-white/75 truncate">{ext.name} <span class="text-white/30">{ext.version}</span></p>
                <p class="text-[10px] {ext.error ? 'text-red-300/70' : 'text-white/30'} truncate">{ext.error ?? ext.path}</p>
            </div>
        </div>
    {:else}
        <p class="text-[11px] text-white/30 px-1">No extensions installed.</p>
    {/each}
    <div class="flex items-center gap-2">
        <button onclick={() => bucks.extensions.openFolder().catch((e) => (message = errorMessage(e)))}
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/10 text-[12px] text-white/70"><FolderOpen size={12} /> Open folder</button>
        <button onclick={() => apply(bucks.extensions.reload())} disabled={busy}
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 text-[12px] text-white/70"><RefreshCw size={12} class={busy ? "animate-spin" : ""} /> Reload</button>
        {#if message}<span class="text-[11px] text-red-300/80">{message}</span>{/if}
    </div>
</div>
