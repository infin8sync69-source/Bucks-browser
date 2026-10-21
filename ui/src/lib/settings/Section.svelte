<script lang="ts">
    import type { Snippet } from 'svelte';

    let { title, hint = '', children }: { title: string; hint?: string; children: Snippet } = $props();
</script>

<section class="space-y-3">
    <div>
        <p class="text-3xs uppercase tracking-caps-wide text-fg-faint font-bold">{title}</p>
        {#if hint}<p class="text-2xs text-fg-faint mt-1">{hint}</p>{/if}
    </div>
    <div class="space-y-2">
        {@render children()}
    </div>
</section>
