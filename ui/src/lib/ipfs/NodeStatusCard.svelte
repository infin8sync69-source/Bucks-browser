<script lang="ts">
    import { Play, Square, RotateCw } from 'lucide-svelte';
    import { ipfsStore } from '$lib/ipfsStore';
    import { formatBytes, formatRate, errorMessage } from '$lib/format';

    let busy = $state<'start' | 'stop' | 'restart' | null>(null);
    let actionError = $state('');

    const status = $derived($ipfsStore.status);
    const info = $derived($ipfsStore.nodeInfo);
    const stats = $derived($ipfsStore.stats);
    const running = $derived(status?.state === 'ready' || status?.state === 'initializing');

    function dotClass(state: string | undefined) {
        if (state === 'ready') return 'bg-emerald-500';
        if (state === 'initializing') return 'bg-yellow-400 animate-pulse';
        if (state === 'error') return 'bg-red-500';
        return 'bg-zinc-500';
    }

    function label(state: string | undefined) {
        if (state === 'ready') return 'Online';
        if (state === 'initializing') return 'Starting…';
        if (state === 'error') return 'Error';
        if (state === 'stopped') return 'Stopped';
        return 'Idle';
    }

    async function run(kind: 'start' | 'stop' | 'restart') {
        busy = kind;
        actionError = '';
        try {
            if (kind === 'stop') await ipfsStore.stop();
            else {
                if (kind === 'restart') await ipfsStore.stop();
                await ipfsStore.start();
            }
        } catch (e) {
            actionError = errorMessage(e);
        } finally {
            busy = null;
            void ipfsStore.refreshStatus();
        }
    }

    // Stats are only meaningful while the node is up; refresh them whenever it becomes ready.
    $effect(() => {
        if (status?.state !== 'ready') return;
        void ipfsStore.refreshStats();
        const timer = setInterval(() => void ipfsStore.refreshStats(), 10_000);
        return () => clearInterval(timer);
    });
</script>

{#if status}
    <div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 space-y-4">
        <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2 text-sm font-medium">
                <span class="w-2 h-2 rounded-full {dotClass(status.state)}"></span>
                Node {label(status.state)}
                <span class="text-xs font-normal text-zinc-500">
                    {status.source === 'embedded_kubo' ? 'embedded Kubo' : status.source === 'external_api' ? 'external API' : 'public gateway'}
                </span>
            </div>
            <div class="flex items-center gap-2">
                {#if status.embedded}
                    {#if !running}
                        <button onclick={() => run('start')} disabled={busy !== null}
                                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/70 hover:bg-emerald-600 disabled:opacity-40 text-xs font-medium transition-colors">
                            <Play size={12} /> Start
                        </button>
                    {:else}
                        <button onclick={() => run('restart')} disabled={busy !== null}
                                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 disabled:opacity-40 text-xs transition-colors">
                            <RotateCw size={12} class={busy === 'restart' ? 'animate-spin' : ''} /> Restart
                        </button>
                        <button onclick={() => run('stop')} disabled={busy !== null}
                                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-red-500/20 disabled:opacity-40 text-xs transition-colors">
                            <Square size={12} /> Stop
                        </button>
                    {/if}
                {/if}
            </div>
        </div>

        <p class="text-xs text-zinc-400">{status.message}</p>
        {#if actionError}<p class="text-xs text-red-400">{actionError}</p>{/if}

        <dl class="border-t border-white/5 pt-3 grid grid-cols-[6.5rem_1fr] gap-y-1.5 text-xs">
            <dt class="text-zinc-500">Version</dt>
            <dd class="text-zinc-300">{status.version ?? info?.agent_version ?? '—'}</dd>
            <dt class="text-zinc-500">Peer ID</dt>
            <dd class="font-mono text-zinc-300 break-all">{status.peer_id ?? info?.peer_id ?? '—'}</dd>
            <dt class="text-zinc-500">API URL</dt>
            <dd class="font-mono text-zinc-300 break-all">{status.api_url ?? '—'}</dd>
            <dt class="text-zinc-500">Gateway URL</dt>
            <dd class="font-mono text-zinc-300 break-all">{status.gateway_url ?? '—'}</dd>
            {#if info && info.addresses.length > 0}
                <dt class="text-zinc-500">Addresses</dt>
                <dd class="space-y-0.5">
                    {#each info.addresses.slice(0, 4) as addr (addr)}
                        <div class="font-mono text-zinc-400 break-all">{addr}</div>
                    {/each}
                    {#if info.addresses.length > 4}
                        <div class="text-zinc-600">+{info.addresses.length - 4} more</div>
                    {/if}
                </dd>
            {/if}
        </dl>

        {#if status.state === 'ready'}
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div class="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                    <div class="text-[10px] uppercase tracking-widest text-zinc-500">Repo size</div>
                    <div class="text-sm text-zinc-200 mt-1">{stats ? formatBytes(stats.repo_size) : '…'}</div>
                    {#if stats && stats.storage_max > 0}
                        <div class="text-[10px] text-zinc-600">of {formatBytes(stats.storage_max)}</div>
                    {/if}
                </div>
                <div class="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                    <div class="text-[10px] uppercase tracking-widest text-zinc-500">Objects</div>
                    <div class="text-sm text-zinc-200 mt-1">{stats ? stats.num_objects.toLocaleString() : '…'}</div>
                </div>
                <div class="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                    <div class="text-[10px] uppercase tracking-widest text-zinc-500">Peers</div>
                    <div class="text-sm text-zinc-200 mt-1">{stats ? stats.peers.toLocaleString() : '…'}</div>
                </div>
                <div class="rounded-xl bg-white/[0.03] border border-white/5 p-3">
                    <div class="text-[10px] uppercase tracking-widest text-zinc-500">Bandwidth</div>
                    {#if stats?.bw}
                        <div class="text-xs text-zinc-200 mt-1">↓ {formatRate(stats.bw.rate_in)}</div>
                        <div class="text-xs text-zinc-200">↑ {formatRate(stats.bw.rate_out)}</div>
                    {:else}
                        <div class="text-sm text-zinc-200 mt-1">{stats ? '—' : '…'}</div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
{:else}
    <div class="rounded-2xl border border-white/5 bg-white/[0.03] p-4 flex items-center gap-3 text-sm text-zinc-500">
        <span class="w-2 h-2 rounded-full bg-zinc-500 animate-pulse"></span>
        Connecting to IPFS node…
    </div>
{/if}
