<script lang="ts">
    import { onMount } from "svelte";
    import { fade } from "svelte/transition";
    import { RefreshCw, MonitorSmartphone } from "lucide-svelte";
    import { browserStore } from "$lib/stores";
    import { settingsStore } from "$lib/settingsStore";
    import { bucks, type AgentStatus, type AppInfo, type SecurityStats, type Settings, type SettingsPatch } from "$lib/bridge";
    import { SEARCH_ENGINES } from "$lib/search";
    import { errorMessage } from "$lib/format";
    import Section from "$lib/settings/Section.svelte";
    import ToggleRow from "$lib/settings/ToggleRow.svelte";
    import TextRow from "$lib/settings/TextRow.svelte";
    import RadioGroup from "$lib/settings/RadioGroup.svelte";
    import SoulEngineSettings from "$lib/settings/SoulEngineSettings.svelte";
    import BrowsingDataSettings from "$lib/settings/BrowsingDataSettings.svelte";
    import ExtensionsSettings from "$lib/settings/ExtensionsSettings.svelte";

    const s = $derived($settingsStore);

    let saveError = $state("");
    let securityStats = $state<SecurityStats | null>(null);
    let appInfo = $state<AppInfo | null>(null);
    let agentStatus = $state<AgentStatus | null>(null);
    let models = $state<string[]>([]);
    let detecting = $state(false);
    let detectMessage = $state("");

    /** Persist a partial settings patch; the main process validates and broadcasts the result. */
    async function save(patch: SettingsPatch) {
        saveError = "";
        try {
            await settingsStore.patch(patch);
        } catch (e) {
            saveError = errorMessage(e);
        }
    }

    async function loadAgentStatus() {
        try {
            agentStatus = await bucks.agent.status();
        } catch {
            agentStatus = null;
        }
    }

    async function detectModels() {
        detecting = true;
        detectMessage = "";
        try {
            models = await bucks.agent.listModels();
            detectMessage = models.length > 0 ? `${models.length} model${models.length === 1 ? "" : "s"} found` : "No models found";
        } catch (e) {
            models = [];
            detectMessage = errorMessage(e);
        } finally {
            detecting = false;
        }
    }

    async function refreshStats() {
        try {
            securityStats = await bucks.security.stats();
        } catch {
            securityStats = null;
        }
    }

    onMount(() => {
        void settingsStore.init();
        void refreshStats();
        void loadAgentStatus();
        bucks.app.info().then((i) => (appInfo = i)).catch(() => {});
        const timer = setInterval(refreshStats, 5000);
        return () => clearInterval(timer);
    });

    // The agent status line should follow provider changes.
    let lastProvider = "";
    $effect(() => {
        const p = s?.agent.provider ?? "";
        if (p && p !== lastProvider) {
            if (lastProvider) void loadAgentStatus();
            lastProvider = p;
        }
    });

    const providerOptions: { id: Settings["agent"]["provider"]; label: string; hint: string }[] = [
        { id: "offline", label: "Offline (built-in intents only)", hint: "no network" },
        { id: "remote", label: "Remote agent server", hint: "Bucks agent API" },
        { id: "ollama", label: "Ollama (local model)", hint: "on-device" },
        { id: "soul", label: "Soul Engine (full agent)", hint: "tools · web research · cards" },
    ];

    function clearData() {
        if (!confirm("Remove all tabs, spaces, bookmarks and history? This cannot be undone.")) return;
        browserStore.resetAll();
    }
</script>

<div class="min-h-full bg-[#07070a] text-white px-8 py-10 max-w-2xl mx-auto space-y-10" in:fade={{ duration: 300 }}>

    <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-base">⚙️</div>
        <h1 class="text-lg font-semibold tracking-tight">Settings</h1>
    </div>

    {#if saveError}
        <p class="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">{saveError}</p>
    {/if}

    {#if !s}
        <p class="text-[13px] text-white/40">Loading settings…</p>
    {:else}
        <!-- Search engine -->
        <Section title="Default Search Engine">
            <RadioGroup
                name="search-engine"
                value={s.searchEngine}
                options={SEARCH_ENGINES.map((e) => ({ id: e.id, label: e.label, hint: `${e.url}…` }))}
                onchange={(v) => save({ searchEngine: v })}
            />
        </Section>

        <!-- IPFS -->
        <Section title="IPFS" hint="Applies to ipfs:// and ipns:// pages and to the IPFS dashboard.">
            <RadioGroup
                name="ipfs-mode"
                accent="emerald"
                value={s.ipfs.mode}
                options={[
                    { id: "embedded", label: "Embedded Kubo node", hint: "managed by Bucks" },
                    { id: "external", label: "External node (API URL)", hint: "e.g. http://127.0.0.1:5001" },
                ]}
                onchange={(v) => save({ ipfs: { mode: v } })}
            />
            {#if s.ipfs.mode === "external"}
                <TextRow
                    label="External API URL"
                    value={s.ipfs.externalApiUrl}
                    placeholder="http://127.0.0.1:5001"
                    onchange={(v) => save({ ipfs: { externalApiUrl: v } })}
                />
            {/if}
            <RadioGroup
                name="ipfs-gateway"
                accent="emerald"
                value={s.ipfs.preferredGateway}
                options={[
                    { id: "local", label: "Use the local node's gateway (fastest)" },
                    { id: "public", label: "Use the public gateway" },
                ]}
                onchange={(v) => save({ ipfs: { preferredGateway: v } })}
            />
            <TextRow
                label="Public gateway URL"
                value={s.ipfs.publicGateway}
                placeholder="https://ipfs.io"
                description="Used when it is preferred, and as the fallback while the local node is not ready."
                onchange={(v) => save({ ipfs: { publicGateway: v } })}
            />
            <ToggleRow
                label="Start the node automatically"
                description="Launch the embedded node when Bucks Browser starts."
                checked={s.ipfs.autoStart}
                onchange={(v) => save({ ipfs: { autoStart: v } })}
            />
        </Section>

        <!-- Devices -->
        <Section title="Devices" hint="Pair your other Bucks installs (for example a Mac and a Linux laptop) to send files between them over IPFS.">
            <ToggleRow
                label="Pin files from my devices automatically"
                description="Files your paired devices send are pinned on arrival, so they stay available on this computer."
                checked={s.devices?.autoPin ?? false}
                onchange={(v) => save({ devices: { autoPin: v } })}
            />
            <div class="flex items-center justify-between gap-4 p-3 rounded-2xl border border-white/[0.06] bg-white/[0.02]">
                <div class="min-w-0">
                    <p class="text-[13px] text-white/70">Paired devices</p>
                    <p class="text-[11px] text-white/30 mt-0.5">
                        {(s.ipfs.peers?.length ?? 0) === 0 ? "None yet" : `${s.ipfs.peers.length} paired`}{s.devices?.name ? ` · this device is "${s.devices.name}"` : ""}
                    </p>
                </div>
                <a
                    href="bucks://ipfs"
                    onclick={(e) => { e.preventDefault(); browserStore.createOrFocusTab("bucks://ipfs"); }}
                    class="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 text-[12px] text-white/70 transition-colors shrink-0"
                >
                    <MonitorSmartphone size={12} /> Manage devices
                </a>
            </div>
        </Section>

        <!-- Security -->
        <Section title="Security & Privacy">
            <ToggleRow
                label="HTTPS-only mode"
                description="Upgrade http:// to https://; falls back to http only when the site has no working HTTPS."
                checked={s.security.httpsOnly}
                onchange={(v) => save({ security: { httpsOnly: v } })}
            />
            <ToggleRow
                label="Block ads and trackers"
                description="Network-level filtering of known ad and tracking domains."
                checked={s.security.adBlock && s.security.trackerBlock}
                onchange={(v) => save({ security: { adBlock: v, trackerBlock: v } })}
            />
            <ToggleRow
                label="Block third-party cookies"
                checked={s.security.blockThirdPartyCookies}
                onchange={(v) => save({ security: { blockThirdPartyCookies: v } })}
            />
            <div class="grid grid-cols-3 gap-2">
                <div class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <p class="text-[10px] uppercase tracking-widest text-white/30">Blocked</p>
                    <p class="text-lg text-white/80 mt-1">{securityStats ? securityStats.blockedRequests.toLocaleString() : "—"}</p>
                    <p class="text-[10px] text-white/25">requests</p>
                </div>
                <div class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <p class="text-[10px] uppercase tracking-widest text-white/30">Upgraded</p>
                    <p class="text-lg text-white/80 mt-1">{securityStats ? securityStats.httpsUpgrades.toLocaleString() : "—"}</p>
                    <p class="text-[10px] text-white/25">to HTTPS</p>
                </div>
                <div class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <p class="text-[10px] uppercase tracking-widest text-white/30">Ad filter</p>
                    <p class="text-lg mt-1 {securityStats?.adBlockReady ? 'text-emerald-400' : 'text-white/40'}">
                        {securityStats ? (securityStats.adBlockReady ? "Ready" : "Loading") : "—"}
                    </p>
                    <p class="text-[10px] text-white/25">filter lists</p>
                </div>
            </div>
            <BrowsingDataSettings />
        </Section>

        <!-- Wallet -->
        <Section title="Wallet" hint="Requests are sent to this node by the main process; keys never leave the wallet page.">
            <TextRow
                label="Bucks node URL"
                value={s.wallet.nodeUrl}
                placeholder="http://127.0.0.1:8080"
                onchange={(v) => save({ wallet: { nodeUrl: v } })}
            />
        </Section>

        <!-- Agent -->
        <Section title="Agent">
            <RadioGroup
                name="agent-provider"
                accent="violet"
                value={s.agent.provider}
                options={providerOptions}
                onchange={(v) => save({ agent: { provider: v } })}
            />
            {#if s.agent.provider === "remote"}
                <TextRow
                    label="Agent server URL"
                    value={s.agent.remoteUrl}
                    placeholder="http://localhost:3000"
                    onchange={(v) => save({ agent: { remoteUrl: v } })}
                />
            {:else if s.agent.provider === "ollama"}
                <TextRow
                    label="Ollama URL"
                    value={s.agent.ollamaUrl}
                    placeholder="http://127.0.0.1:11434"
                    onchange={(v) => save({ agent: { ollamaUrl: v } })}
                />
                <TextRow
                    label="Model"
                    value={s.agent.ollamaModel}
                    placeholder="llama3.2"
                    onchange={(v) => save({ agent: { ollamaModel: v } })}
                />
                <div class="flex items-center gap-3">
                    <button
                        onclick={detectModels}
                        disabled={detecting}
                        class="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 text-[12px] text-white/70 transition-colors"
                    >
                        <RefreshCw size={12} class={detecting ? "animate-spin" : ""} /> Detect models
                    </button>
                    {#if detectMessage}<span class="text-[11px] text-white/40">{detectMessage}</span>{/if}
                </div>
                {#if models.length > 0}
                    <div class="flex flex-wrap gap-1.5">
                        {#each models as m (m)}
                            <button
                                onclick={() => save({ agent: { ollamaModel: m } })}
                                class="px-3 py-1 rounded-full text-[11px] border transition-colors
                                       {s.agent.ollamaModel === m ? 'border-violet-400/50 bg-violet-500/15 text-violet-200' : 'border-white/10 bg-white/[0.03] text-white/50 hover:text-white'}"
                            >{m}</button>
                        {/each}
                    </div>
                {/if}
            {:else if s.agent.provider === "soul"}
                <SoulEngineSettings {s} {save} />
            {/if}
            {#if agentStatus}
                <p class="text-[11px] text-white/30">
                    Status: {agentStatus.online ? "online" : "offline"} · provider {agentStatus.provider}{agentStatus.model ? ` · ${agentStatus.model}` : ""}
                </p>
            {/if}
        </Section>

        <Section title="Extensions">
            <ExtensionsSettings />
        </Section>

        <!-- Downloads -->
        <Section title="Downloads">
            <TextRow
                label="Download directory"
                value={s.downloads.directory}
                placeholder="Default downloads folder"
                description="Leave empty to use the operating system's downloads folder."
                onchange={(v) => save({ downloads: { directory: v } })}
            />
            <ToggleRow
                label="Ask where to save each file"
                checked={s.downloads.askWhereToSave}
                onchange={(v) => save({ downloads: { askWhereToSave: v } })}
            />
        </Section>
    {/if}

    <!-- About -->
    <Section title="About">
        <div class="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 grid grid-cols-[7rem_1fr] gap-y-1.5 text-[12px]">
            <span class="text-white/30">Application</span>
            <span class="text-white/70">{appInfo?.name ?? "Bucks Browser"} {appInfo?.version ?? ""}</span>
            <span class="text-white/30">Electron</span>
            <span class="text-white/70">{bucks.versions.electron}</span>
            <span class="text-white/30">Chromium</span>
            <span class="text-white/70">{bucks.versions.chrome}</span>
            <span class="text-white/30">Node.js</span>
            <span class="text-white/70">{bucks.versions.node}</span>
            <span class="text-white/30">Platform</span>
            <span class="text-white/70">{bucks.platform}</span>
            {#if appInfo?.userData}
                <span class="text-white/30">Profile</span>
                <span class="text-white/70 font-mono break-all">{appInfo.userData}</span>
            {/if}
        </div>
    </Section>

    <!-- Danger zone -->
    <section class="space-y-3 pt-4 border-t border-white/[0.06]">
        <p class="text-[10px] uppercase tracking-[0.3em] text-red-400/50 font-bold">Danger Zone</p>
        <div class="rounded-2xl border border-red-500/15 bg-red-500/5 p-4 flex items-center justify-between gap-4">
            <div>
                <p class="text-[13px] text-white/60 font-medium">Reset the browser</p>
                <p class="text-[11px] text-white/30 mt-0.5">Removes all tabs, spaces, bookmarks and history</p>
            </div>
            <button onclick={clearData}
                class="px-4 py-2 rounded-xl bg-red-500/15 hover:bg-red-500/25 border border-red-500/25 text-red-400 text-[12px] font-medium transition-all">
                Clear Data
            </button>
        </div>
    </section>
</div>
