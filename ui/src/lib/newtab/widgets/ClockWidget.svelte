<script lang="ts">
    // World clock: local time and up to four other time zones.
    import { onMount } from "svelte";
    import { Plus, X } from "lucide-svelte";
    import { MAX_ZONES, knownTimeZones, timeIn, validTimeZone, zoneCity, type Widget } from "../board";
    import { boardStore } from "../stores";

    let { widget }: { widget: Widget } = $props();

    let now = $state(new Date());
    let adding = $state(false);
    let zoneInput = $state("");
    let error = $state("");
    const allZones = knownTimeZones();
    const zones = $derived(widget.config.zones ?? []);
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    onMount(() => {
        const t = setInterval(() => (now = new Date()), 15_000);
        return () => clearInterval(t);
    });

    function addZone() {
        const input = zoneInput.trim();
        const tz = allZones.find((z) => z.toLowerCase() === input.toLowerCase())
            ?? allZones.find((z) => zoneCity(z).toLowerCase() === input.toLowerCase());
        if (!tz || !validTimeZone(tz)) { error = "Pick a zone from the list, e.g. Asia/Tokyo"; return; }
        boardStore.configure(widget.uid, { zones: [...zones.filter((z) => z !== tz), tz] });
        zoneInput = "";
        error = "";
        adding = false;
    }

    const removeZone = (tz: string) => boardStore.configure(widget.uid, { zones: zones.filter((z) => z !== tz) });
    const offsetLabel = (d: number) => (d > 0 ? " +1 day" : d < 0 ? " −1 day" : "");
</script>

<div class="space-y-2">
    <div class="flex items-baseline justify-between">
        <span class="text-3xl font-light text-fg tabular-nums">{timeIn(localZone, now).time}</span>
        <span class="text-2xs text-fg-faint">{zoneCity(localZone)}</span>
    </div>
    {#each zones as tz (tz)}
        {@const t = timeIn(tz, now)}
        <div class="group flex items-center gap-2 text-xs">
            <span class="text-fg-subtle truncate">{zoneCity(tz)}</span>
            <span class="text-3xs text-fg-faint">{offsetLabel(t.dayOffset)}</span>
            <span class="ml-auto text-fg-muted tabular-nums">{t.time}</span>
            <button onclick={() => removeZone(tz)} title="Remove {zoneCity(tz)}" aria-label="Remove {zoneCity(tz)}"
                class="opacity-0 group-hover:opacity-100 text-fg-faint hover:text-fg transition-opacity"><X size={11} /></button>
        </div>
    {/each}
    {#if adding}
        <form onsubmit={(e) => { e.preventDefault(); addZone(); }} class="flex gap-1.5">
            <input bind:value={zoneInput} list="bucks-tz-{widget.uid}" placeholder="City or zone, e.g. Tokyo"
                aria-label="Time zone" class="flex-1 min-w-0 bg-surface-2 border border-line rounded-lg px-2 py-1 text-2xs text-fg-muted placeholder-fg-faint outline-none focus:border-line-emphasis" />
            <datalist id="bucks-tz-{widget.uid}">
                {#each allZones as z (z)}<option value={z}>{zoneCity(z)}</option>{/each}
            </datalist>
            <button type="submit" class="px-2 rounded-lg bg-surface-3 hover:bg-surface-4 text-2xs text-fg-muted">Add</button>
        </form>
        {#if error}<p class="text-3xs text-warning-fg-strong/70">{error}</p>{/if}
    {:else if zones.length < MAX_ZONES}
        <button onclick={() => (adding = true)} class="flex items-center gap-1 text-2xs text-fg-faint hover:text-fg-muted transition-colors">
            <Plus size={11} /> Add a city
        </button>
    {/if}
</div>
