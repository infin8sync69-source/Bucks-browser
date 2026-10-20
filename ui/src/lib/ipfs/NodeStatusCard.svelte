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
        if (state === 'ready') return 'bg-success';
        if (state === 'initializing') return 'bg-warning animate-pulse';
        if (state === 'error') return 'bg-danger';
        return 'bg-fg-faint';
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
    <div class="rounded-2xl border border-line-subtle bg-surface-1 p-4 space-y-4">
        <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="flex items-center gap-2 text-md font-medium">
                <span class="w-2 h-2 rounded-full {dotClass(status.state)}"></span>
                Node {label(status.state)}
                <span class="text-xs font-normal text-fg-faint">
                    {status.source === 'embedded_kubo' ? 'embedded Kubo' : status.source === 'external_api' ? 'external API' : 'public gateway'}
                </span>
            </div>
            <div class="flex items-center gap-2">
                {#if status.embedded}
                    {#if !running}
                        <button onclick={() => run('start')} disabled={busy !== null}
                                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-success/70 hover:bg-success-emphasis-hover disabled:opacity-40 text-xs font-medium transition-colors">
                            <Play size={12} /> Start
                        </button>
                    {:else}
                        <button onclick={() => run('restart')} disabled={busy !== null}
                                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 hover:bg-surface-4 disabled:opacity-40 text-xs transition-colors">
                            <RotateCw size={12} class={busy === 'restart' ? 'animate-spin' : ''} /> Restart
                        </button>
                        <button onclick={() => run('stop')} disabled={busy !== null}
                                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-3 hover:bg-danger/20 disabled:opacity-40 text-xs transition-colors">
                            <Square size={12} /> Stop
                        </button>
                    {/if}
                {/if}
            </div>
        </div>

        <p class="text-xs text-fg-subtle">{status.message}</p>
        {#if actionError}<p class="text-xs text-danger-fg">{actionError}</p>{/if}

        <dl class="border-t border-line-subtle pt-3 grid grid-cols-[6.5rem_1fr] gap-y-1.5 text-xs">
            <dt class="text-fg-faint">Version</dt>
            <dd class="text-fg-muted">{status.version ?? info?.agent_version ?? '—'}</dd>
            <dt class="text-fg-faint">Peer ID</dt>
            <dd class="font-mono text-fg-muted break-all">{status.peer_id ?? info?.peer_id ?? '—'}</dd>
            <dt class="text-fg-faint">API URL</dt>
            <dd class="font-mono text-fg-muted break-all">{status.api_url ?? '—'}</dd>
            <dt class="text-fg-faint">Gateway URL</dt>
            <dd class="font-mono text-fg-muted break-all">{status.gateway_url ?? '—'}</dd>
            {#if info && info.addresses.length > 0}
                <dt class="text-fg-faint">Addresses</dt>
                <dd class="space-y-0.5">
                    {#each info.addresses.slice(0, 4) as addr (addr)}
                        <div class="font-mono text-fg-subtle break-all">{addr}</div>
                    {/each}
                    {#if info.addresses.length > 4}
                        <div class="text-fg-faint">+{info.addresses.length - 4} more</div>
                    {/if}
                </dd>
            {/if}
        </dl>

        {#if status.state === 'ready'}
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div class="rounded-xl bg-surface-1 border border-line-subtle p-3">
                    <div class="text-3xs uppercase tracking-widest text-fg-faint">Repo size</div>
                    <div class="text-md text-fg mt-1">{stats ? formatBytes(stats.repo_size) : '…'}</div>
                    {#if stats && stats.storage_max > 0}
                        <div class="text-3xs text-fg-faint">of {formatBytes(stats.storage_max)}</div>
                    {/if}
                </div>
                <div class="rounded-xl bg-surface-1 border border-line-subtle p-3">
                    <div class="text-3xs uppercase tracking-widest text-fg-faint">Objects</div>
                    <div class="text-md text-fg mt-1">{stats ? stats.num_objects.toLocaleString() : '…'}</div>
                </div>
                <div class="rounded-xl bg-surface-1 border border-line-subtle p-3">
                    <div class="text-3xs uppercase tracking-widest text-fg-faint">Peers</div>
                    <div class="text-md text-fg mt-1">{stats ? stats.peers.toLocaleString() : '…'}</div>
                </div>
                <div class="rounded-xl bg-surface-1 border border-line-subtle p-3">
                    <div class="text-3xs uppercase tracking-widest text-fg-faint">Bandwidth</div>
                    {#if stats?.bw}
                        <div class="text-xs text-fg mt-1">↓ {formatRate(stats.bw.rate_in)}</div>
                        <div class="text-xs text-fg">↑ {formatRate(stats.bw.rate_out)}</div>
                    {:else}
                        <div class="text-md text-fg mt-1">{stats ? '—' : '…'}</div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
{:else}
    <div class="rounded-2xl border border-line-subtle bg-surface-1 p-4 flex items-center gap-3 text-md text-fg-faint">
        <span class="w-2 h-2 rounded-full bg-fg-faint animate-pulse"></span>
        Connecting to IPFS node…
    </div>
{/if}
