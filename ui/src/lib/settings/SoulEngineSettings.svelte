<script lang="ts">
    // Settings → Agent → Soul Engine: backend choice, start/stop/install, live status.
    // The engine itself is run by the main process (src/main/agent/soul-engine.js).
    import { onMount } from "svelte";
    import { Play, Square, RotateCw, Download } from "lucide-svelte";
    import { bucks, type Settings, type SettingsPatch, type SoulBackend, type SoulStatus } from "$lib/bridge";
    import { errorMessage } from "$lib/format";
    import RadioGroup from "./RadioGroup.svelte";
    import ToggleRow from "./ToggleRow.svelte";
    import TextRow from "./TextRow.svelte";

    let { s, save }: { s: Settings; save: (patch: SettingsPatch) => Promise<void> } = $props();

    let status = $state<SoulStatus | null>(null);
    let busy = $state(false);
    let actionError = $state("");

    const backendOptions: { id: SoulBackend; label: string; hint: string }[] = [
        { id: "edge", label: "On-device model (embedded)", hint: "private · downloads once" },
        { id: "ollama", label: "Ollama on this computer", hint: "uses the Ollama URL below" },
        { id: "nim", label: "NVIDIA NIM (cloud)", hint: "your key · prompts leave the device" },
        { id: "litai", label: "Lightning AI (cloud)", hint: "your key · prompts leave the device" },
    ];

    const tone: Record<string, string> = {
        ready: "bg-emerald-400",
        loading: "bg-amber-400 animate-pulse",
        starting: "bg-amber-400 animate-pulse",
        installing: "bg-amber-400 animate-pulse",
        error: "bg-red-400",
        unavailable: "bg-red-400",
    };

    const running = $derived(status ? ["starting", "loading", "ready", "error"].includes(status.state) && !!status.url : false);
    const needsInstall = $derived(status?.state === "unavailable" && /Python/.test(status.message));

    function soulPatch(patch: Partial<Settings["agent"]["soul"]>) {
        return save({ agent: { soul: { ...s.agent.soul, ...patch } } });
    }

    async function run(action: () => Promise<SoulStatus>) {
        busy = true;
        actionError = "";
        try {
            status = await action();
        } catch (e) {
            actionError = errorMessage(e);
        } finally {
            busy = false;
        }
    }

    onMount(() => {
        bucks.agent.soulStatus().then((st) => (status = st)).catch(() => {});
        return bucks.agent.onSoulStatus((st) => (status = st));
    });
</script>

<div class="space-y-3">
    <p class="text-[11px] text-white/35 leading-relaxed">
        The Soul Engine is Bucks' full agent: it searches and reads the web, works with IPFS and answers with cards
        (tables, charts, checklists). It runs on this computer as a separate process that only Bucks can talk to.
    </p>

    <RadioGroup
        name="soul-backend"
        accent="violet"
        value={s.agent.soul.backend}
        options={backendOptions}
        onchange={(v) => soulPatch({ backend: v })}
    />

    {#if s.agent.soul.backend === "ollama"}
        <TextRow label="Ollama URL" value={s.agent.ollamaUrl} placeholder="http://127.0.0.1:11434" onchange={(v) => save({ agent: { ollamaUrl: v } })} />
        <TextRow label="Ollama model" value={s.agent.ollamaModel} placeholder="llama3.2" onchange={(v) => save({ agent: { ollamaModel: v } })} />
    {:else if s.agent.soul.backend === "nim" || s.agent.soul.backend === "litai"}
        <p class="text-[11px] text-amber-200/70 leading-relaxed">
            With a cloud backend your questions and the page text you ask about are sent to
            {s.agent.soul.backend === "nim" ? "NVIDIA" : "Lightning AI"}. Put your own key
            ({s.agent.soul.backend === "nim" ? "NGC_API_KEY" : "LITAI_API_KEY"}=…) in
            <span class="font-mono break-all">{status?.dataDir ? `${status.dataDir}/.env` : "the Soul Engine folder's .env file"}</span>,
            then restart the engine.
        </p>
    {/if}

    <ToggleRow
        label="Start with Bucks"
        description="Start the engine when Bucks opens while it is the selected agent."
        checked={s.agent.soul.autoStart}
        onchange={(v) => soulPatch({ autoStart: v })}
    />

    <div class="p-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] space-y-2.5">
        <div class="flex items-center gap-2">
            <span class="w-2 h-2 rounded-full shrink-0 {tone[status?.state ?? ''] ?? 'bg-white/20'}"></span>
            <span class="text-[12px] text-white/70 capitalize">{status?.state ?? "unknown"}</span>
            {#if status?.model}<span class="ml-auto text-[10px] text-white/30 font-mono truncate max-w-[220px]">{status.model}</span>{/if}
        </div>
        {#if status?.message}<p class="text-[11px] text-white/40 leading-relaxed break-words">{status.message}</p>{/if}
        <div class="flex flex-wrap items-center gap-2">
            {#if running}
                <button
                    onclick={() => run(() => bucks.agent.soulStop())}
                    disabled={busy}
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 text-[12px] text-white/70 transition-colors"
                ><Square size={11} /> Stop</button>
                <button
                    onclick={() => run(async () => { await bucks.agent.soulStop(); return bucks.agent.soulStart(); })}
                    disabled={busy}
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 text-[12px] text-white/70 transition-colors"
                ><RotateCw size={11} /> Restart</button>
            {:else}
                <button
                    onclick={() => run(() => bucks.agent.soulStart())}
                    disabled={busy || status?.state === "installing"}
                    class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/30 disabled:opacity-40 text-[12px] text-violet-100 transition-colors"
                ><Play size={11} /> Start</button>
            {/if}
            <button
                onclick={() => run(() => bucks.agent.soulInstall())}
                disabled={busy || status?.state === "installing"}
                title="Create a private Python environment for the engine and install its packages"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] transition-colors disabled:opacity-40
                       {needsInstall ? 'bg-violet-500/20 hover:bg-violet-500/30 border border-violet-400/30 text-violet-100' : 'bg-white/[0.06] hover:bg-white/10 text-white/50'}"
            ><Download size={11} /> {needsInstall ? "Install" : "Reinstall packages"}</button>
        </div>
        {#if actionError}<p class="text-[11px] text-red-300/80 break-words">{actionError}</p>{/if}
    </div>
</div>
