<script lang="ts">
    import { duration as motion } from '$design/dist/tokens.js';
    import { tokenRgba } from '$design/runtime/color.js';
    import { fade, fly } from "svelte/transition";
    import { onMount, onDestroy } from "svelte";
    import { cubicOut } from "svelte/easing";
    import { X } from "lucide-svelte";
    import HomeScreen from "./HomeScreen.svelte";
    import AppStore from "./AppStore.svelte";
    import HeroClock from "./newtab/HeroClock.svelte";
    import PendingUpdates from "./newtab/PendingUpdates.svelte";
    import StatusCards from "./newtab/StatusCards.svelte";
    import WidgetBoard from "./newtab/WidgetBoard.svelte";
    import { browserStore, activeTab } from "./stores";
    import { chatOpen } from "./uiState";

    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D;
    let animationFrame: number;
    let mouseX = $state(typeof window !== 'undefined' ? window.innerWidth / 2 : 800);
    let mouseY = $state(typeof window !== 'undefined' ? window.innerHeight / 2 : 500);

    let storeOpen = $state(false);

    // ── canvas particles ─────────────────────────────────────────────────────
    interface Node { x: number; y: number; vx: number; vy: number; r: number; }
    let nodes: Node[] = [];

    function initCanvas() {
        if (!canvas) return;
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx = canvas.getContext("2d")!;
        nodes = Array.from({ length: 60 }, () => ({
            x:  Math.random() * canvas.width,
            y:  Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.2,
            vy: (Math.random() - 0.5) * 0.2,
            r:  Math.random() * 1.0 + 0.3,
        }));
    }

    function drawFrame() {
        if (!ctx || !canvas) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const DIST = 130;

        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            n.x += n.vx; n.y += n.vy;
            if (n.x < 0 || n.x > canvas.width)  n.vx *= -1;
            if (n.y < 0 || n.y > canvas.height) n.vy *= -1;

            const dx = n.x - mouseX, dy = n.y - mouseY;
            const d  = Math.sqrt(dx*dx + dy*dy);
            if (d < 160) { const f = (160-d)/6000; n.vx += (dx/d)*f; n.vy += (dy/d)*f; }

            const spd = Math.sqrt(n.vx*n.vx + n.vy*n.vy);
            if (spd > 0.5) { n.vx = (n.vx/spd)*0.5; n.vy = (n.vy/spd)*0.5; }

            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
            ctx.fillStyle = tokenRgba('fg', d < 120 ? 0.15 : 0.05);
            ctx.fill();

            for (let j = i+1; j < nodes.length; j++) {
                const m = nodes[j];
                const ex = n.x-m.x, ey = n.y-m.y;
                const dsq = ex*ex + ey*ey;
                if (dsq < DIST*DIST) {
                    const a = (1 - Math.sqrt(dsq)/DIST) * 0.1;
                    ctx.beginPath();
                    ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y);
                    ctx.strokeStyle = tokenRgba('agent', a);
                    ctx.lineWidth = 0.4;
                    ctx.stroke();
                }
            }
        }
        animationFrame = requestAnimationFrame(drawFrame);
    }

    onMount(() => {
        initCanvas();
        drawFrame();
        window.addEventListener("resize", initCanvas);
    });

    onDestroy(() => {
        cancelAnimationFrame(animationFrame);
        window.removeEventListener("resize", initCanvas);
    });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
    role="presentation"
    onmousemove={(e) => { mouseX = e.clientX; mouseY = e.clientY; }}
    class="fixed inset-0 bg-canvas-deep overflow-hidden z-base"
    in:fade={{ duration: motion.slower }}
>
    <!-- Particle canvas -->
    <canvas bind:this={canvas} class="absolute inset-0 pointer-events-none opacity-50"></canvas>

    <!-- Aurora blobs -->
    <div class="absolute inset-0 pointer-events-none overflow-hidden">
        <div class="aurora-blob blob-1"></div>
        <div class="aurora-blob blob-2"></div>
        <div class="aurora-blob blob-3"></div>
    </div>

    <!-- Mouse glow -->
    <div
        class="absolute inset-0 pointer-events-none"
        style="background: radial-gradient(500px circle at {mouseX}px {mouseY}px, color-mix(in srgb, var(--bucks-color-cat-purple-deep) 6%, transparent), transparent 70%);"
    ></div>

    <!-- The dashboard scrolls below the Header and left of the chat drawer. It runs under the command
         bar (taller on the new tab: it shows suggestions) with room to scroll everything above it. -->
    <div class="thin-scrollbar absolute left-0 top-[5.5rem] bottom-0 overflow-y-auto transition-[right] duration-moderate {$chatOpen ? 'right-chat-panel' : 'right-0'}">
        <div class="mx-auto w-full max-w-[980px] px-6 pt-6 pb-55 flex flex-col items-center gap-7">
            <HeroClock />
            <PendingUpdates />
            <HomeScreen onOpenStore={() => storeOpen = true} />
            <StatusCards />
            <WidgetBoard />
            <p class="pt-2 text-3xs uppercase tracking-caps-wide text-fg-disabled font-medium select-none" in:fly={{ y: 10, duration: motion.slowest, delay: 500, easing: cubicOut }}>soul of the world</p>
        </div>
    </div>
    <!-- Content fades out under the command bar (popovers such as the model picker stay above this) -->
    <div class="absolute left-0 right-0 bottom-0 h-[230px] z-lift pointer-events-none bg-gradient-to-t from-canvas-deep via-canvas-deep/85 to-transparent"></div>

    <!-- Close button — top-right, below the header island -->
    {#if $activeTab}
        <button
            onclick={() => browserStore.closeTab($activeTab!.id)}
            title="Close tab"
            class="absolute top-[5.75rem] {$chatOpen ? 'right-chat-panel-gap' : 'right-6'} z-raised w-8 h-8 flex items-center justify-center
                   rounded-xl bg-surface-2 border border-line text-fg-faint
                   hover:bg-surface-4 hover:text-fg hover:border-line-emphasis
                   transition-all duration-base active:scale-90"
            in:fade={{ duration: motion.moderate, delay: 400 }}
        >
            <X size={14} />
        </button>
    {/if}
</div>

<!-- AppStore overlay -->
{#if storeOpen}
    <AppStore onclose={() => storeOpen = false} />
{/if}

<style>
    .aurora-blob {
        position: absolute;
        border-radius: 50%;
        filter: blur(var(--bucks-blur-4xl));
        opacity: 0.09;
        pointer-events: none;
    }
    .blob-1 {
        width: 600px; height: 600px;
        background: radial-gradient(circle, var(--bucks-color-cat-violet-strong), transparent 70%);
        top: -15%; left: -10%;
        animation: drift1 calc(var(--bucks-duration-drift) * 0.85) var(--bucks-easing-in-out) infinite;
    }
    .blob-2 {
        width: 500px; height: 500px;
        background: radial-gradient(circle, var(--bucks-color-cat-blue-strong), transparent 70%);
        bottom: -10%; right: -5%;
        animation: drift2 var(--bucks-duration-drift) var(--bucks-easing-in-out) infinite;
    }
    .blob-3 {
        width: 380px; height: 380px;
        background: radial-gradient(circle, var(--bucks-color-cat-teal-strong), transparent 70%);
        top: 40%; left: 55%;
        animation: drift3 calc(var(--bucks-duration-drift) * 1.15) var(--bucks-easing-in-out) infinite;
    }
    @keyframes drift1 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(60px,50px)} }
    @keyframes drift2 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-50px,-40px)} }
    @keyframes drift3 { 0%,100%{transform:translate(0,0)} 33%{transform:translate(-40px,30px)} 66%{transform:translate(40px,-25px)} }
</style>
