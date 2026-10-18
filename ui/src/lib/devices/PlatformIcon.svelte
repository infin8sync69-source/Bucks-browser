<script lang="ts">
    import { Laptop, Monitor, MonitorSmartphone } from 'lucide-svelte';
    import { platformLabel } from '$lib/format';

    /** Icon for a process.platform value (decorative; pair it with a visible label). */
    let { platform, size = 16 }: { platform: string | null | undefined; size?: number } = $props();
</script>

<span class="inline-flex text-zinc-400" title={platformLabel(platform)} aria-hidden="true">
    {#if platform === 'darwin'}
        <Laptop {size} />
    {:else if platform === 'linux' || platform === 'win32' || platform === 'freebsd' || platform === 'openbsd'}
        <Monitor {size} />
    {:else}
        <MonitorSmartphone {size} />
    {/if}
</span>
