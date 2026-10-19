<script lang="ts">
    // Weather for a city you choose, from Open-Meteo through the main process. Only the city name
    // is sent; the report refreshes every 15 minutes while the new tab is open.
    import { onMount } from "svelte";
    import { Sun, CloudSun, Cloud, CloudFog, CloudDrizzle, CloudRain, CloudSnow, CloudLightning, Wind, Droplets, MapPin } from "lucide-svelte";
    import { bucks, type WeatherReport } from "$lib/bridge";
    import { errorMessage } from "$lib/format";
    import type { Widget } from "../board";
    import { boardStore } from "../stores";

    let { widget }: { widget: Widget } = $props();

    const ICONS = { sun: Sun, "cloud-sun": CloudSun, cloud: Cloud, fog: CloudFog, drizzle: CloudDrizzle, rain: CloudRain, snow: CloudSnow, storm: CloudLightning } as const;

    let report = $state<WeatherReport | null>(null);
    let error = $state("");
    let loading = $state(false);
    let editing = $state(false);
    let cityInput = $state("");
    const city = $derived(widget.config.city ?? "");

    async function load(c: string) {
        if (!c) return;
        loading = true;
        error = "";
        try {
            report = await bucks.widgets.weather(c);
        } catch (e) {
            error = errorMessage(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        } finally {
            loading = false;
        }
    }

    function setCity() {
        const c = cityInput.trim();
        if (!c) return;
        boardStore.configure(widget.uid, { city: c });
        editing = false;
        void load(c);
    }

    let lastCity = "";
    $effect(() => {
        if (city === lastCity) return;
        lastCity = city;
        void load(city);
    });

    onMount(() => {
        const t = setInterval(() => void load(city), 15 * 60_000);
        return () => clearInterval(t);
    });

    const dayName = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
</script>

{#if !city || editing}
    <form onsubmit={(e) => { e.preventDefault(); setCity(); }} class="space-y-2">
        <p class="text-[11px] text-white/45">Which city?</p>
        <div class="flex gap-1.5">
            <input bind:value={cityInput} placeholder="e.g. Lisbon" aria-label="City"
                class="flex-1 min-w-0 bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1.5 text-[12px] text-white/80 placeholder-white/25 outline-none focus:border-white/20" />
            <button type="submit" class="px-3 rounded-lg bg-white/[0.06] hover:bg-white/10 text-[11px] text-white/70">Show</button>
        </div>
        <p class="text-[10px] text-white/25">Forecasts by Open-Meteo. Only the city name is sent.</p>
    </form>
{:else if report}
    {@const Icon = ICONS[report.icon as keyof typeof ICONS] ?? Cloud}
    <div class="space-y-2">
        <div class="flex items-center gap-3">
            <Icon size={30} class="text-white/70" strokeWidth={1.5} />
            <div>
                <div class="text-[26px] font-light text-white/90 leading-none tabular-nums">{Math.round(report.temperature)}{report.units.temperature}</div>
                <div class="text-[11px] text-white/45 mt-1">{report.label}</div>
            </div>
            <button onclick={() => { cityInput = city; editing = true; }} title="Change city"
                class="ml-auto self-start flex items-center gap-1 text-[11px] text-white/45 hover:text-white/80 transition-colors">
                <MapPin size={11} /> {report.place.name}
            </button>
        </div>
        <div class="flex gap-3 text-[10px] text-white/35">
            {#if report.wind !== null}<span class="flex items-center gap-1"><Wind size={10} />{Math.round(report.wind)} {report.units.wind}</span>{/if}
            {#if report.humidity !== null}<span class="flex items-center gap-1"><Droplets size={10} />{report.humidity} %</span>{/if}
        </div>
        <div class="grid grid-cols-3 gap-1 pt-1">
            {#each report.days as d (d.date)}
                {@const DayIcon = ICONS[d.icon as keyof typeof ICONS] ?? Cloud}
                <div class="flex flex-col items-center gap-0.5 rounded-lg bg-white/[0.03] py-1.5" title={d.label}>
                    <span class="text-[10px] text-white/40">{dayName(d.date)}</span>
                    <DayIcon size={14} class="text-white/55" />
                    <span class="text-[10px] text-white/70 tabular-nums">{Math.round(d.max)}° <span class="text-white/30">{Math.round(d.min)}°</span></span>
                </div>
            {/each}
        </div>
    </div>
{:else if error}
    <div class="space-y-2">
        <p class="text-[11px] text-amber-200/70">{error}</p>
        <div class="flex gap-3 text-[11px]">
            <button onclick={() => load(city)} class="text-white/50 hover:text-white">Try again</button>
            <button onclick={() => { cityInput = city; editing = true; }} class="text-white/50 hover:text-white">Change city</button>
        </div>
    </div>
{:else}
    <p class="text-[11px] text-white/35">{loading ? `Loading the weather for ${city}…` : ""}</p>
{/if}
