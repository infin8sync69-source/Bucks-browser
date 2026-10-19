<script lang="ts">
    // Generative-UI cards from the Soul Engine (tables, stats, checklists, …). The main process has
    // already reduced them to plain data (src/main/agent/genui.js); everything here is rendered as
    // text, links open in a new tab, and no remote images are loaded into the chrome.
    import { ExternalLink, Search, Check } from "lucide-svelte";
    import type { UiComponent } from "./bridge";
    import { browserStore } from "./stores";
    import { settingsStore } from "./settingsStore";

    let { components }: { components: UiComponent[] } = $props();

    const open = (url: string) => browserStore.createTab(url);
    const search = (q: string) => browserStore.createTab(settingsStore.searchUrl(q));

    function maxOf(series: { value: number }[]) {
        return Math.max(1e-9, ...series.map((p) => Math.abs(p.value)));
    }

    const fmt = (n: number | null, unit = "") => (n === null ? "–" : `${Math.round(n)}${unit}`);
</script>

<div class="space-y-2 mt-2">
    {#each components as c, i (i)}
        <div class="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-3.5 py-3 text-[12px] text-zinc-300">
            {#if c.title}<p class="text-[11px] font-semibold text-white/70 mb-2">{c.title}</p>{/if}

            {#if c.component === "answer"}
                <p class="whitespace-pre-wrap leading-relaxed">{c.text}</p>

            {:else if c.component === "list"}
                <ul class="space-y-1.5">
                    {#each c.items as it, j (j)}
                        <li>
                            {#if it.url}
                                <button onclick={() => open(it.url)} class="group text-left w-full">
                                    <span class="flex items-center gap-1 text-violet-300 group-hover:text-violet-200">
                                        <span class="truncate">{it.title || it.url}</span><ExternalLink size={10} class="shrink-0 opacity-60" />
                                    </span>
                                    {#if it.subtitle}<span class="block text-[11px] text-white/35 line-clamp-2">{it.subtitle}</span>{/if}
                                </button>
                            {:else}
                                <span class="text-white/70">{it.title}</span>
                                {#if it.subtitle}<span class="block text-[11px] text-white/35">{it.subtitle}</span>{/if}
                            {/if}
                        </li>
                    {/each}
                </ul>

            {:else if c.component === "table"}
                <div class="overflow-x-auto">
                    <table class="w-full border-collapse text-[11px]">
                        {#if c.columns.length}
                            <thead>
                                <tr>{#each c.columns as col, j (j)}<th class="text-left font-medium text-white/60 border-b border-white/10 px-2 py-1">{col}</th>{/each}</tr>
                            </thead>
                        {/if}
                        <tbody>
                            {#each c.rows as row, r (r)}
                                <tr class="odd:bg-white/[0.02]">{#each row as cell, j (j)}<td class="px-2 py-1 align-top text-white/70">{cell}</td>{/each}</tr>
                            {/each}
                        </tbody>
                    </table>
                </div>

            {:else if c.component === "stats"}
                <div class="grid grid-cols-2 gap-2">
                    {#each c.stats as st, j (j)}
                        <div class="rounded-xl bg-white/[0.04] px-2.5 py-2">
                            <p class="text-[10px] text-white/40">{st.label}</p>
                            <p class="text-[14px] font-semibold text-white/85">{st.value}</p>
                            {#if st.delta}<p class="text-[10px] {st.delta.startsWith('-') ? 'text-red-300/80' : 'text-emerald-300/80'}">{st.delta}</p>{/if}
                        </div>
                    {/each}
                </div>

            {:else if c.component === "chart"}
                {@const max = maxOf(c.series)}
                <div class="space-y-1">
                    {#each c.series as p, j (j)}
                        <div class="flex items-center gap-2">
                            <span class="w-24 shrink-0 truncate text-[11px] text-white/50">{p.label}</span>
                            <div class="flex-1 h-2 rounded-full bg-white/[0.05] overflow-hidden">
                                <div class="h-full rounded-full bg-violet-400/70" style="width: {Math.max(2, (Math.abs(p.value) / max) * 100)}%"></div>
                            </div>
                            <span class="w-14 shrink-0 text-right text-[11px] font-mono text-white/60">{p.value}</span>
                        </div>
                    {/each}
                </div>

            {:else if c.component === "timeline"}
                <ol class="space-y-2 border-l border-white/10 pl-3">
                    {#each c.events as e, j (j)}
                        <li>
                            {#if e.date}<p class="text-[10px] font-mono text-violet-300/80">{e.date}</p>{/if}
                            <p class="text-white/75">{e.title}</p>
                            {#if e.text}<p class="text-[11px] text-white/40">{e.text}</p>{/if}
                        </li>
                    {/each}
                </ol>

            {:else if c.component === "checklist"}
                <ul class="space-y-1">
                    {#each c.items as it, j (j)}
                        <li class="flex items-start gap-2">
                            <span class="mt-0.5 w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center {it.done ? 'bg-emerald-500/30 border-emerald-400/50' : 'border-white/20'}">
                                {#if it.done}<Check size={9} class="text-emerald-200" />{/if}
                            </span>
                            <span class={it.done ? "line-through text-white/35" : "text-white/70"}>{it.text}</span>
                        </li>
                    {/each}
                </ul>

            {:else if c.component === "accordion"}
                <div class="space-y-1">
                    {#each c.items as it, j (j)}
                        <details class="rounded-xl bg-white/[0.03] px-2.5 py-1.5">
                            <summary class="cursor-pointer text-white/75">{it.heading}</summary>
                            <p class="mt-1 text-[11px] text-white/45 whitespace-pre-wrap">{it.text}</p>
                        </details>
                    {/each}
                </div>

            {:else if c.component === "code"}
                <pre class="overflow-x-auto rounded-xl bg-black/40 p-2.5 text-[11px] font-mono text-emerald-200/90"><code>{c.code}</code></pre>
                {#if c.language}<p class="mt-1 text-[10px] text-white/30 font-mono">{c.language}</p>{/if}

            {:else if c.component === "weather"}
                <div class="flex items-baseline gap-3">
                    <span class="text-[22px] font-semibold text-white/85">{fmt(c.current.temp_c, "°")}</span>
                    <span class="text-white/60">{c.current.condition}</span>
                    {#if c.place}<span class="ml-auto text-[11px] text-white/35">{c.place}</span>{/if}
                </div>
                <p class="text-[10px] text-white/35 mt-0.5">
                    feels {fmt(c.current.feels_c, "°")} · wind {fmt(c.current.wind_kmh, " km/h")} · humidity {fmt(c.current.humidity, "%")}
                </p>
                {#if c.days.length}
                    <div class="mt-2 grid grid-cols-4 gap-1.5">
                        {#each c.days.slice(0, 8) as d, j (j)}
                            <div class="rounded-lg bg-white/[0.04] px-1.5 py-1 text-center">
                                <p class="text-[10px] text-white/45">{d.day}</p>
                                <p class="text-[11px] text-white/75">{fmt(d.high_c, "°")} / {fmt(d.low_c, "°")}</p>
                            </div>
                        {/each}
                    </div>
                {/if}

            {:else if c.component === "links"}
                <div class="flex flex-wrap gap-1.5">
                    {#each c.actions as a, j (j)}
                        {#if "url" in a}
                            <button onclick={() => open(a.url)} class="inline-flex items-center gap-1 rounded-full border border-violet-400/25 bg-violet-500/10 px-2.5 py-1 text-[11px] text-violet-200 hover:bg-violet-500/20">
                                <ExternalLink size={10} /> {a.label}
                            </button>
                        {:else}
                            <button onclick={() => search(a.query)} class="inline-flex items-center gap-1 rounded-full border border-sky-400/25 bg-sky-500/10 px-2.5 py-1 text-[11px] text-sky-200 hover:bg-sky-500/20">
                                <Search size={10} /> {a.label}
                            </button>
                        {/if}
                    {/each}
                </div>
            {/if}
        </div>
    {/each}
</div>
