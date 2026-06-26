<script lang="ts">
    import { fade, fly } from "svelte/transition";
    import { onMount, onDestroy } from "svelte";
    import { cubicOut } from "svelte/easing";
    import { X } from "lucide-svelte";
    import HomeScreen from "./HomeScreen.svelte";
    import AppStore from "./AppStore.svelte";
    import { browserStore, activeTab } from "./stores";

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
            ctx.fillStyle = `rgba(255,255,255,${d < 120 ? 0.15 : 0.05})`;
            ctx.fill();

            for (let j = i+1; j < nodes.length; j++) {
                const m = nodes[j];
                const ex = n.x-m.x, ey = n.y-m.y;
                const dsq = ex*ex + ey*ey;
                if (dsq < DIST*DIST) {
                    const a = (1 - Math.sqrt(dsq)/DIST) * 0.1;
                    ctx.beginPath();
                    ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y);
                    ctx.strokeStyle = `rgba(139,92,246,${a})`;
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
    class="fixed inset-0 bg-[#030307] overflow-hidden z-0"
    in:fade={{ duration: 800 }}
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
        style="background: radial-gradient(500px circle at {mouseX}px {mouseY}px, rgba(88,28,135,0.06), transparent 70%);"
    ></div>

    <!-- HomeScreen grid — lives in the safe area between Header and AgenticBar -->
    <div class="absolute inset-0 top-[5.5rem] bottom-28">
        <HomeScreen onOpenStore={() => storeOpen = true} />
    </div>

    <!-- Close button — top-right, below the header island -->
    {#if $activeTab}
        <button
            onclick={() => browserStore.closeTab($activeTab!.id)}
            title="Close tab"
            class="absolute top-[5.75rem] right-6 z-10 w-8 h-8 flex items-center justify-center
                   rounded-xl bg-white/[0.05] border border-white/[0.08] text-white/30
                   hover:bg-white/[0.12] hover:text-white hover:border-white/20
                   transition-all duration-200 active:scale-90"
            in:fade={{ duration: 300, delay: 400 }}
        >
            <X size={14} />
        </button>
    {/if}

    <!-- Bottom wordmark -->
    <div
        class="absolute bottom-24 left-0 right-0 flex flex-col items-center select-none pointer-events-none"
        in:fly={{ y: 10, duration: 1000, delay: 500, easing: cubicOut }}
    >
        <p class="text-[10px] uppercase tracking-[0.45em] text-white/12 font-medium">soul of the world</p>
    </div>
</div>

<!-- AppStore overlay -->
{#if storeOpen}
    <AppStore onclose={() => storeOpen = false} />
{/if}

<style>
    .aurora-blob {
        position: absolute;
        border-radius: 50%;
        filter: blur(100px);
        opacity: 0.09;
        pointer-events: none;
    }
    .blob-1 {
        width: 600px; height: 600px;
        background: radial-gradient(circle, #6d28d9, transparent 70%);
        top: -15%; left: -10%;
        animation: drift1 22s ease-in-out infinite;
    }
    .blob-2 {
        width: 500px; height: 500px;
        background: radial-gradient(circle, #1d4ed8, transparent 70%);
        bottom: -10%; right: -5%;
        animation: drift2 26s ease-in-out infinite;
    }
    .blob-3 {
        width: 380px; height: 380px;
        background: radial-gradient(circle, #0d9488, transparent 70%);
        top: 40%; left: 55%;
        animation: drift3 30s ease-in-out infinite;
    }
    @keyframes drift1 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(60px,50px)} }
    @keyframes drift2 { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-50px,-40px)} }
    @keyframes drift3 { 0%,100%{transform:translate(0,0)} 33%{transform:translate(-40px,30px)} 66%{transform:translate(40px,-25px)} }
</style>
