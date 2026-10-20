<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    // The agent card's model picker: which provider answers, and which model it uses. The Soul
    // Engine lists its on-device models (with size, whether they fit in memory and whether they
    // are downloaded) and its backends; Ollama lists its installed models.
    import { onMount, onDestroy } from "svelte";
    import { scale } from "svelte/transition";
    import { Check, Download, LoaderCircle } from "lucide-svelte";
    import { bucks, type SoulBackend, type SoulDownloadProgress, type SoulModels } from "$lib/bridge";
    import { settingsStore } from "$lib/settingsStore";
    import { swarmStore } from "$lib/swarmStore";
    import { errorMessage, formatBytes } from "$lib/format";

    let { onclose, up = false }: { onclose: () => void; up?: boolean } = $props();

    const PROVIDERS = [
        { id: "soul", label: "Soul Engine", hint: "on this computer" },
        { id: "ollama", label: "Ollama", hint: "on this computer" },
        { id: "remote", label: "Remote agent", hint: "your server" },
        { id: "offline", label: "Offline rules", hint: "no model" },
    ] as const;
    const BACKENDS: { id: SoulBackend; label: string }[] = [
        { id: "edge", label: "On-device model" },
        { id: "ollama", label: "Ollama" },
        { id: "nim", label: "NVIDIA NIM (cloud)" },
        { id: "litai", label: "Lightning AI (cloud)" },
    ];

    let soul = $state<SoulModels | null>(null);
    let ollamaModels = $state<string[]>([]);
    let loading = $state(true);
    let error = $state("");
    let switching = $state<string | null>(null);
    let progress = $state<SoulDownloadProgress | null>(null);
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const s = $derived($settingsStore);
    const provider = $derived(s?.agent.provider ?? "offline");
    const backend = $derived(s?.agent.soul.backend ?? "edge");

    async function load() {
        loading = true;
        error = "";
        try {
            if (provider === "soul") {
                soul = await bucks.agent.soulModels().catch((e) => {
                    error = /not running/.test(errorMessage(e)) ? "The Soul Engine is not running yet." : errorMessage(e);
                    return null;
                });
            } else if (provider === "ollama") {
                ollamaModels = await bucks.agent.listModels().catch(() => []);
            }
        } finally {
            loading = false;
        }
    }

    async function setProvider(id: string) {
        if (!s || id === provider) return;
        await settingsStore.patch({ agent: { provider: id as typeof provider } });
        void swarmStore.checkOnline();
        await load();
    }

    async function setBackend(id: SoulBackend) {
        if (!s || id === backend) return;
        await settingsStore.patch({ agent: { soul: { ...s.agent.soul, backend: id } } });
        soul = null;
        error = "The Soul Engine restarts with the new backend…";
    }

    async function setOllamaModel(m: string) {
        if (!s || m === s.agent.ollamaModel) return;
        await settingsStore.patch({ agent: { ollamaModel: m } });
        void swarmStore.checkOnline();
    }

    async function selectModel(id: string) {
        switching = id;
        error = "";
        pollTimer = setInterval(async () => {
            progress = await bucks.agent.soulDownloadProgress().catch(() => null);
        }, 1000);
        try {
            soul = await bucks.agent.soulSelectModel(id);
            void swarmStore.checkOnline();
        } catch (e) {
            error = errorMessage(e);
        } finally {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            progress = null;
            switching = null;
        }
    }

    function pct(p: SoulDownloadProgress | null) {
        return p?.active && p.totalBytes ? Math.min(100, Math.round((p.downloadedBytes / p.totalBytes) * 100)) : null;
    }

    onMount(() => {
        void load();
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onclose();
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });
    onDestroy(() => {
        if (pollTimer) clearInterval(pollTimer);
    });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
    class="absolute right-0 {up ? 'bottom-full mb-2' : 'top-full mt-2'} z-dropdown w-[300px] max-h-[420px] overflow-y-auto rounded-2xl border border-line-strong bg-surface-raised/95 backdrop-blur-xl shadow-2xl p-2 text-left"
    role="dialog"
    aria-label="Choose model"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    transition:scale={{ duration: motion.fast, start: 0.96 }}
>
    <p class="px-2 pt-1 pb-1.5 text-3xs uppercase tracking-wider text-fg-faint">Agent</p>
    {#each PROVIDERS as p (p.id)}
        <button onclick={() => setProvider(p.id)}
            class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-surface-3 transition-colors">
            <span class="w-3.5 flex-shrink-0 text-success-fg-strong">{#if provider === p.id}<Check size={13} />{/if}</span>
            <span class="text-xs text-fg-muted">{p.label}</span>
            <span class="ml-auto text-3xs text-fg-faint">{p.hint}</span>
        </button>
    {/each}

    {#if provider === "soul"}
        <div class="h-px bg-surface-3 my-2"></div>
        <p class="px-2 pb-1.5 text-3xs uppercase tracking-wider text-fg-faint">Soul Engine backend</p>
        {#each BACKENDS as b (b.id)}
            <button onclick={() => setBackend(b.id)}
                class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-surface-3 transition-colors">
                <span class="w-3.5 flex-shrink-0 text-success-fg-strong">{#if backend === b.id}<Check size={13} />{/if}</span>
                <span class="text-xs text-fg-muted">{b.label}</span>
            </button>
        {/each}

        {#if backend === "edge"}
            <div class="h-px bg-surface-3 my-2"></div>
            <p class="px-2 pb-1.5 text-3xs uppercase tracking-wider text-fg-faint">On-device models</p>
            {#if loading}
                <p class="px-2 py-2 text-2xs text-fg-faint">Loading…</p>
            {:else if soul?.models.length}
                <div class="max-h-[220px] overflow-y-auto">
                    {#each soul.models as m (m.id)}
                        {@const disabled = (!m.fitsRam && !m.current) || switching !== null}
                        <button onclick={() => selectModel(m.id)} {disabled}
                            title={!m.fitsRam ? "Needs more memory than this computer has free" : m.downloaded ? "" : "Downloads the first time"}
                            class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-surface-3 disabled:opacity-35 disabled:hover:bg-transparent transition-colors">
                            <span class="w-3.5 flex-shrink-0 text-success-fg-strong">
                                {#if switching === m.id}<LoaderCircle size={13} class="animate-spin text-fg-subtle" />{:else if m.current}<Check size={13} />{/if}
                            </span>
                            <span class="min-w-0 flex-1">
                                <span class="block text-xs text-fg-muted font-mono truncate">{m.id}</span>
                                {#if switching === m.id && pct(progress) !== null}
                                    <span class="block text-3xs text-warning-fg-strong/70">Downloading {pct(progress)} % · {formatBytes(progress?.downloadedBytes ?? 0)}</span>
                                {:else if !m.downloaded}
                                    <span class="flex items-center gap-1 text-3xs text-fg-faint"><Download size={9} /> download</span>
                                {/if}
                            </span>
                            <span class="text-3xs text-fg-faint tabular-nums">{m.sizeGb} GB</span>
                        </button>
                    {/each}
                </div>
                <p class="px-2 pt-1.5 text-3xs text-fg-faint leading-snug">Larger models answer better but slower. Greyed out: not enough free memory.</p>
            {/if}
        {/if}
    {:else if provider === "ollama"}
        <div class="h-px bg-surface-3 my-2"></div>
        <p class="px-2 pb-1.5 text-3xs uppercase tracking-wider text-fg-faint">Ollama models</p>
        {#if loading}
            <p class="px-2 py-2 text-2xs text-fg-faint">Loading…</p>
        {:else if ollamaModels.length}
            <div class="max-h-[220px] overflow-y-auto">
                {#each ollamaModels as m (m)}
                    <button onclick={() => setOllamaModel(m)}
                        class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-surface-3 transition-colors">
                        <span class="w-3.5 flex-shrink-0 text-success-fg-strong">{#if s?.agent.ollamaModel === m}<Check size={13} />{/if}</span>
                        <span class="text-xs text-fg-muted font-mono truncate">{m}</span>
                    </button>
                {/each}
            </div>
        {:else}
            <p class="px-2 py-1 text-2xs text-fg-faint">No models found. Install one with <code class="text-fg-subtle">ollama pull llama3.2</code>.</p>
        {/if}
    {/if}

    {#if error}<p class="px-2 pt-2 text-2xs text-warning-fg-strong/80" role="status">{error}</p>{/if}
</div>
