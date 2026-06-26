<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { ArrowRight, Search, Zap, Globe, Code2, Sparkles, Compass, Play } from "lucide-svelte";
    import type { A2UI } from "./swarmStore";

    export let a2ui: A2UI;
    const dispatch = createEventDispatcher<{ click: void }>();

    const isClickable = a2ui.type === "action" || a2ui.type === "navigate" || a2ui.type === "open_tab" || a2ui.type === "search";

    let icon = Zap;
    let label = "Action";

    $: {
        switch (a2ui.type) {
            case "navigate":
                icon = ArrowRight;
                label = a2ui.url ? `Navigate: ${a2ui.url}` : "Navigate";
                break;
            case "open_tab":
                icon = ArrowRight;
                label = a2ui.url ? `Open tab: ${a2ui.url}` : "Open tab";
                break;
            case "search":
                icon = Search;
                label = a2ui.content ? `Search: ${a2ui.content}` : "Search";
                break;
            case "action":
                icon = Sparkles;
                label = a2ui.action ? a2ui.action.replace(/_/g, " ") : "Action";
                break;
            case "scrape":
                icon = Globe;
                label = a2ui.url ? `Scrape: ${a2ui.url}` : "Scrape";
                break;
            case "code":
                icon = Code2;
                label = a2ui.language ? `Code: ${a2ui.language}` : "Code";
                break;
            default:
                icon = Compass;
                label = a2ui.content ? a2ui.content : a2ui.type;
        }
    }

    function handleClick() {
        if (!isClickable) return;
        dispatch("click");
    }
</script>

<button
    type="button"
    class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold transition-all duration-200
           {isClickable ? 'bg-white/5 border-white/10 text-white hover:bg-white/10 hover:border-white/20' : 'bg-white/5 border-white/5 text-white/40 cursor-not-allowed'}"
    on:click={handleClick}
    disabled={!isClickable}
>
    <svelte:component this={icon} size={12} class="text-violet-300" />
    <span>{label}</span>
</button>
