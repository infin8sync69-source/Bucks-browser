<script lang="ts">
    // Settings → Privacy & data: clear what pages and browsing left behind, and the OS default browser.
    import { onMount } from "svelte";
    import { bucks, type DefaultBrowserStatus } from "$lib/bridge";
    import { browserStore } from "$lib/stores";
    import { errorMessage } from "$lib/format";

    let what = $state({ history: true, cookies: false, cache: true, siteData: false, closedTabs: true });
    let busy = $state(false);
    let result = $state("");
    let defaultStatus = $state<DefaultBrowserStatus | null>(null);
    let defaultError = $state("");

    const options: { key: keyof typeof what; label: string; hint: string }[] = [
        { key: "history", label: "Browsing history", hint: "Pages you visited" },
        { key: "closedTabs", label: "Recently closed tabs", hint: "The list behind Reopen closed tab" },
        { key: "cookies", label: "Cookies", hint: "Signs you out of most sites" },
        { key: "cache", label: "Cached images and files", hint: "Pages load slower the next time" },
        { key: "siteData", label: "Site data", hint: "Local storage, IndexedDB, service workers of every site" },
    ];

    async function clearNow() {
        busy = true;
        result = "";
        try {
            if (what.cookies || what.cache || what.siteData) {
                await bucks.browsingData.clear({ cookies: what.cookies, cache: what.cache, siteData: what.siteData });
            }
            if (what.history) browserStore.clearHistory();
            if (what.closedTabs) browserStore.clearClosedTabs();
            const n = Object.values(what).filter(Boolean).length;
            result = n ? "Cleared." : "Nothing selected.";
        } catch (e) {
            result = errorMessage(e);
        } finally {
            busy = false;
        }
    }

    async function makeDefault() {
        defaultError = "";
        try {
            defaultStatus = await bucks.app.setDefaultBrowser();
        } catch (e) {
            defaultError = errorMessage(e);
        }
    }

    onMount(() => {
        bucks.app.defaultBrowser().then((st) => (defaultStatus = st)).catch(() => {});
    });
</script>

<div class="space-y-3">
    <div class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
        <p class="text-[13px] text-white/70">Clear browsing data</p>
        {#each options as o (o.key)}
            <label class="flex items-start gap-3 px-1 py-1 cursor-pointer">
                <input type="checkbox" bind:checked={what[o.key]} class="mt-0.5 accent-blue-500" />
                <span>
                    <span class="block text-[12px] text-white/70">{o.label}</span>
                    <span class="block text-[10px] text-white/30">{o.hint}</span>
                </span>
            </label>
        {/each}
        <div class="flex items-center gap-3 pt-1">
            <button onclick={clearNow} disabled={busy}
                class="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 text-[12px] text-white/80 transition-colors">
                {busy ? "Clearing…" : "Clear now"}
            </button>
            {#if result}<span class="text-[11px] text-white/40">{result}</span>{/if}
        </div>
        <p class="text-[10px] text-white/25">Private tabs never keep any of this: their data is wiped when the last one closes.</p>
    </div>

    <div class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 flex items-center justify-between gap-4">
        <div class="min-w-0">
            <p class="text-[13px] text-white/70">Default browser</p>
            <p class="text-[11px] text-white/30 mt-0.5">
                {#if defaultStatus?.isDefault}
                    Bucks opens links from other apps, including ipfs:// and ipns:// links.
                {:else if defaultStatus?.opensSystemSettings}
                    Windows only lets you choose this in Settings → Apps → Default apps.
                {:else}
                    Links from other apps open in another browser.
                {/if}
            </p>
            {#if defaultError}<p class="text-[11px] text-red-300/80 mt-1">{defaultError}</p>{/if}
        </div>
        {#if !defaultStatus?.isDefault}
            <button onclick={makeDefault}
                class="flex-shrink-0 px-4 py-2 rounded-xl bg-blue-500/15 hover:bg-blue-500/25 border border-blue-400/25 text-blue-100 text-[12px] transition-colors">
                {defaultStatus?.opensSystemSettings ? "Open Windows settings" : "Make default"}
            </button>
        {:else}
            <span class="flex-shrink-0 text-[11px] text-emerald-300/80">Default</span>
        {/if}
    </div>
</div>
