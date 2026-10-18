<script lang="ts">
    import type { Snippet } from 'svelte';

    let { title, hint = '', children }: { title: string; hint?: string; children: Snippet } = $props();
</script>

<section class="space-y-3">
    <div>
        <p class="text-[10px] uppercase tracking-[0.3em] text-white/30 font-bold">{title}</p>
        {#if hint}<p class="text-[11px] text-white/25 mt-1">{hint}</p>{/if}
    </div>
    <div class="space-y-2">
        {@render children()}
    </div>
</section>
