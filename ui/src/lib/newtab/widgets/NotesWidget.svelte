<script lang="ts">
    // A scratchpad that saves as you type (kept on this computer).
    import { onDestroy, untrack } from "svelte";
    import { MAX_NOTES, type Widget } from "../board";
    import { boardStore } from "../stores";

    let { widget }: { widget: Widget } = $props();

    let text = $state(untrack(() => widget.config.text ?? ""));
    let timer: ReturnType<typeof setTimeout> | null = null;
    let focused = false;

    // Follow changes made in another window, unless you are typing here.
    $effect(() => {
        const stored = widget.config.text ?? "";
        if (!focused && !timer && stored !== text) text = stored;
    });

    function save() {
        if (timer) clearTimeout(timer);
        timer = null;
        boardStore.configure(widget.uid, { text });
    }

    function oninput() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(save, 400);
    }

    onDestroy(() => { if (timer) save(); });
</script>

<textarea bind:value={text} {oninput} onfocus={() => (focused = true)} onblur={() => { focused = false; save(); }}
    maxlength={MAX_NOTES} placeholder="Write anything…" aria-label="Notes"
    class="w-full h-32 resize-none bg-transparent text-[12px] leading-relaxed text-white/80 placeholder-white/25 outline-none"></textarea>
