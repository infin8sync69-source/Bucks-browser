<script lang="ts">
    import '../app.css';
    import SwarmCanvas from '$lib/SwarmCanvas.svelte';
    
    let { children } = $props();
</script>

<SwarmCanvas />

<div class="min-h-screen bg-transparent text-white font-sans antialiased overflow-hidden">
    {@render children()}
</div>
