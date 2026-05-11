<script lang="ts">
    import { fade, fly } from "svelte/transition";
    import { onMount, onDestroy } from "svelte";
    import { cubicOut } from "svelte/easing";

    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D;
    let animationFrame: number;
    let mouseX = $state(window.innerWidth / 2);
    let mouseY = $state(window.innerHeight / 2);

    // ── canvas particles ─────────────────────────────────────────────────────
    interface Node { x: number; y: number; vx: number; vy: number; r: number; }
    let nodes: Node[] = [];

    function initCanvas() {
        if (!canvas) return;
        canvas.width  = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx = canvas.getContext("2d")!;
        nodes = Array.from({ length: 80 }, () => ({
            x:  Math.random() * canvas.width,
            y:  Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.25,
            vy: (Math.random() - 0.5) * 0.25,
            r:  Math.random() * 1.2 + 0.3,
        }));
    }

    function drawFrame() {
        if (!ctx || !canvas) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const DIST = 140;

        for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            n.x += n.vx; n.y += n.vy;
            if (n.x < 0 || n.x > canvas.width)  n.vx *= -1;
            if (n.y < 0 || n.y > canvas.height) n.vy *= -1;

            // subtle mouse repel
            const dx = n.x - mouseX, dy = n.y - mouseY;
            const d  = Math.sqrt(dx*dx + dy*dy);
            if (d < 160) { const f = (160-d)/6000; n.vx += (dx/d)*f; n.vy += (dy/d)*f; }

            // clamp speed
            const spd = Math.sqrt(n.vx*n.vx + n.vy*n.vy);
            if (spd > 0.6) { n.vx = (n.vx/spd)*0.6; n.vy = (n.vy/spd)*0.6; }

            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, Math.PI*2);
            ctx.fillStyle = `rgba(255,255,255,${d < 120 ? 0.18 : 0.06})`;
            ctx.fill();

            for (let j = i+1; j < nodes.length; j++) {
                const m   = nodes[j];
                const ex  = n.x-m.x, ey = n.y-m.y;
                const dsq = ex*ex + ey*ey;
                if (dsq < DIST*DIST) {
                    const a = (1 - Math.sqrt(dsq)/DIST) * 0.12;
                    ctx.beginPath();
                    ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y);
                    ctx.strokeStyle = `rgba(139,92,246,${a})`;
                    ctx.lineWidth   = 0.4;
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
    class="fixed inset-0 flex flex-col items-center justify-center bg-[#030305] overflow-hidden z-0"
    in:fade={{ duration: 1200 }}
>
    <!-- Particle canvas -->
    <canvas bind:this={canvas} class="absolute inset-0 pointer-events-none opacity-60"></canvas>

    <!-- Aurora blobs -->
    <div class="absolute inset-0 pointer-events-none overflow-hidden">
        <div class="aurora-blob blob-1"></div>
        <div class="aurora-blob blob-2"></div>
        <div class="aurora-blob blob-3"></div>
    </div>

    <!-- Mouse glow -->
    <div
        class="absolute inset-0 pointer-events-none transition-opacity duration-700"
        style="background: radial-gradient(600px circle at {mouseX}px {mouseY}px, rgba(88,28,135,0.07), transparent 70%); opacity: 1;"
    ></div>

    <!-- Center content -->
    <div class="relative z-10 flex flex-col items-center gap-3 select-none" in:fly={{ y: 20, duration: 1000, delay: 300, easing: cubicOut }}>
        <h1 class="logo-wordmark text-[108px] font-bold text-white/70 tracking-[-0.06em] leading-none lowercase">
            bucks
        </h1>
        <p class="text-[11px] uppercase tracking-[0.42em] text-white/18 font-medium">soul of the world</p>
    </div>
</div>

<style>
    .logo-wordmark {
        animation: breathe 9s ease-in-out infinite;
        filter: drop-shadow(0 0 40px rgba(139,92,246,0.08));
    }
    @keyframes breathe {
        0%,100% { opacity: 0.55; transform: scale(1); }
        50%      { opacity: 0.75; transform: scale(1.015); filter: drop-shadow(0 0 50px rgba(139,92,246,0.15)); }
    }

    .aurora-blob {
        position: absolute;
        border-radius: 50%;
        filter: blur(80px);
        opacity: 0.12;
        pointer-events: none;
    }
    .blob-1 {
        width: 600px; height: 600px;
        background: radial-gradient(circle, #6d28d9, transparent 70%);
        top: -15%; left: -10%;
        animation: drift1 18s ease-in-out infinite;
    }
    .blob-2 {
        width: 500px; height: 500px;
        background: radial-gradient(circle, #1d4ed8, transparent 70%);
        bottom: -10%; right: -5%;
        animation: drift2 22s ease-in-out infinite;
    }
    .blob-3 {
        width: 400px; height: 400px;
        background: radial-gradient(circle, #0d9488, transparent 70%);
        top: 40%; left: 55%;
        animation: drift3 26s ease-in-out infinite;
    }
    @keyframes drift1 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(80px,60px) scale(1.1)} }
    @keyframes drift2 { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-70px,-50px) scale(1.08)} }
    @keyframes drift3 { 0%,100%{transform:translate(0,0) scale(1)} 33%{transform:translate(-60px,40px) scale(1.05)} 66%{transform:translate(50px,-30px) scale(0.95)} }
</style>
