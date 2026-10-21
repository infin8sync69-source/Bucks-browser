<script lang="ts">
    import { Copy, Check } from 'lucide-svelte';
    import { errorMessage } from '$lib/format';

    /** Copies `text` to the clipboard and confirms with "Copied" for a moment. */
    let { text, label }: { text: string; label: string } = $props();

    let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
    let failure = $state('');
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function copy() {
        clearTimeout(timer);
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard is not available');
            await navigator.clipboard.writeText(text);
            copyState = 'copied';
        } catch (e) {
            failure = errorMessage(e);
            copyState = 'failed';
        }
        timer = setTimeout(() => (copyState = 'idle'), 2000);
    }

    $effect(() => () => clearTimeout(timer));
</script>

<button
    type="button"
    onclick={copy}
    aria-label={label}
    title={copyState === 'failed' ? `Copy failed: ${failure}` : label}
    class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-2xs shrink-0 transition-colors
           {copyState === 'copied' ? 'text-success-fg-strong bg-success/10' : copyState === 'failed' ? 'text-danger-fg-strong bg-danger/10' : 'text-fg-subtle hover:text-fg bg-surface-2 hover:bg-surface-4'}"
>
    {#if copyState === 'copied'}
        <Check size={12} /> Copied
    {:else}
        <Copy size={12} /> {copyState === 'failed' ? 'Copy failed' : 'Copy'}
    {/if}
</button>
