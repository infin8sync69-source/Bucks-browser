<script lang="ts">
    import { fade, fly } from "svelte/transition";
    import { isSwarmThinking } from "./stores";
    import { onMount, onDestroy } from "svelte";

    let mouseX = $state(0);
    let mouseY = $state(0);
    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D;
    let animationFrame: number;

    interface Node {
        x: number;
        y: number;
        vx: number;
        vy: number;
        radius: number;
    }

    let nodes: Node[] = [];
    const NODE_COUNT = 70;
    const CONNECTION_DISTANCE = 150;

    function initCanvas() {
        if (!canvas) return;
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        ctx = canvas.getContext("2d")!;

        nodes = [];
        for (let i = 0; i < NODE_COUNT; i++) {
            nodes.push({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                vx: (Math.random() - 0.5) * 0.3,
                vy: (Math.random() - 0.5) * 0.3,
                radius: Math.random() * 1.0 + 0.2,
            });
        }
    }

    function draw() {
        if (!ctx || !canvas) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        nodes.forEach((node, i) => {
            node.x += node.vx;
            node.y += node.vy;

            if (node.x < 0 || node.x > canvas.width) node.vx *= -1;
            if (node.y < 0 || node.y > canvas.height) node.vy *= -1;

            const dx = node.x - mouseX;
            const dy = node.y - mouseY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Subtle mouse influence
            if (dist < 200) {
                const angle = Math.atan2(dy, dx);
                const force = (200 - dist) / 2000;
                node.vx += Math.cos(angle) * force;
                node.vy += Math.sin(angle) * force;
            }

            ctx.beginPath();
            ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 255, 255, ${0.03 + (dist < 150 ? 0.05 : 0)})`;
            ctx.fill();

            for (let j = i + 1; j < nodes.length; j++) {
                const other = nodes[j];
                const dx = node.x - other.x;
                const dy = node.y - other.y;
                const distSq = dx * dx + dy * dy;

                if (distSq < CONNECTION_DISTANCE * CONNECTION_DISTANCE) {
                    const dist = Math.sqrt(distSq);
                    const opacity = 1 - dist / CONNECTION_DISTANCE;
                    ctx.beginPath();
                    ctx.moveTo(node.x, node.y);
                    ctx.lineTo(other.x, other.y);
                    ctx.strokeStyle = `rgba(139, 92, 246, ${opacity * 0.08})`;
                    ctx.lineWidth = 0.3;
                    ctx.stroke();
                }
            }
        });

        animationFrame = requestAnimationFrame(draw);
    }

    onMount(() => {
        initCanvas();
        draw();
        window.addEventListener("resize", initCanvas);
    });

    onDestroy(() => {
        cancelAnimationFrame(animationFrame);
        window.removeEventListener("resize", initCanvas);
    });

    function handleMouseMove(e: MouseEvent) {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }
</script>

<div
    onmousemove={handleMouseMove}
    role="presentation"
    class="fixed inset-0 flex flex-col items-center justify-center bg-[#030305] overflow-hidden z-0"
    in:fade={{ duration: 1500 }}
>
    <!-- Cosmic Web Canvas -->
    <canvas
        bind:this={canvas}
        class="absolute inset-0 z-0 opacity-50 pointer-events-none filter blur-[0.5px]"
    ></canvas>

    <!-- Deep Ambient Glow -->
    <div
        class="absolute inset-0 transition-opacity duration-1000 z-1"
        style="
            background: radial-gradient(1200px circle at {mouseX}px {mouseY}px, rgba(88, 28, 135, 0.03), rgba(30, 58, 138, 0.02), transparent 80%);
            opacity: {$isSwarmThinking ? 0.6 : 0.3};
        "
    ></div>

    <div
        class="relative z-10 flex flex-col items-center select-none pointer-events-none"
    >
        <!-- Center Logo (Refined Minimalism) -->
        <div
            in:fade={{ duration: 3000, delay: 500 }}
            class="flex flex-col items-center"
        >
            <h1
                class="logo-text text-[72px] font-bold text-white tracking-[-0.06em] leading-none lowercase opacity-60"
            >
                bucks
            </h1>

            <!-- Minimal Tagline -->
            <div
                in:fade={{ duration: 2500, delay: 2000 }}
                class="mt-6 flex flex-col items-center gap-3 opacity-10"
            >
                <div
                    class="h-[1px] w-16 bg-gradient-to-r from-transparent via-white to-transparent"
                ></div>
                <p
                    class="text-[9px] text-white tracking-[1.2em] uppercase font-light ml-[1.2em]"
                >
                    soul of the world
                </p>
            </div>
        </div>
    </div>
</div>

<style>
    :global(body) {
        background: #030305;
        margin: 0;
        overflow: hidden;
    }

    .logo-text {
        animation: breathe 8s ease-in-out infinite;
        filter: drop-shadow(0 0 20px rgba(255, 255, 255, 0.05));
    }

    @keyframes breathe {
        0%,
        100% {
            opacity: 0.5;
            transform: scale(1);
            filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0));
        }
        50% {
            opacity: 0.7;
            transform: scale(1.02);
            filter: drop-shadow(0 0 30px rgba(139, 92, 246, 0.1));
        }
    }
</style>
