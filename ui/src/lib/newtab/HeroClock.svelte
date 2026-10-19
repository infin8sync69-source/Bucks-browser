<script lang="ts">
    // The new tab's clock: the time, a greeting with your name, and the date.
    import { onMount } from "svelte";
    import { greeting } from "./board";
    import { profileStore } from "./stores";
    import { profilePanelOpen } from "$lib/uiState";

    let now = $state(new Date());

    onMount(() => {
        // Tick on the minute boundary, then every minute.
        let timer: ReturnType<typeof setTimeout>;
        const schedule = () => {
            timer = setTimeout(() => { now = new Date(); schedule(); }, 60_000 - (Date.now() % 60_000) + 50);
        };
        schedule();
        return () => clearTimeout(timer);
    });

    const time = $derived(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
    const date = $derived(now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
    const name = $derived($profileStore.name);
</script>

<div class="flex flex-col items-center select-none">
    <div class="text-[64px] leading-none font-extralight tracking-tight text-white/90 tabular-nums" aria-label="Time">{time}</div>
    <div class="mt-2 text-[15px] text-white/70">
        {greeting(now.getHours())}{#if name}, <span class="text-white/90">{name}</span>{/if}
        {#if !name}
            <button onclick={() => profilePanelOpen.set(true)} class="ml-2 text-[11px] text-white/30 hover:text-white/70 underline-offset-2 hover:underline transition-colors">Add your name</button>
        {/if}
    </div>
    <div class="mt-1 text-[12px] text-white/35">{date}</div>
</div>
