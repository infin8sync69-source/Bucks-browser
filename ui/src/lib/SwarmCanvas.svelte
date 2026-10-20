<script lang="ts">
    import { onMount } from "svelte";
    import { isSwarmThinking } from "$lib/stores";
    import { tokenRgba } from "$design/runtime/color.js";

    let canvas: HTMLCanvasElement;

    onMount(() => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let width = window.innerWidth;
        let height = window.innerHeight;
        canvas.width = width;
        canvas.height = height;

        window.addEventListener("resize", () => {
            width = window.innerWidth;
            height = window.innerHeight;
            canvas.width = width;
            canvas.height = height;
        });

        // The Aurora "Soul"
        let mouseX = width / 2;
        let mouseY = height / 2;
        let targetX = width / 2;
        let targetY = height / 2;

        window.addEventListener("mousemove", (e) => {
            targetX = e.clientX;
            targetY = e.clientY;
        });

        let pulseTime = 0;

        function animate() {
            if (!ctx) return;

            // Ease towards mouse
            mouseX += (targetX - mouseX) * 0.05;
            mouseY += (targetY - mouseY) * 0.05;

            // Pulsing logic
            pulseTime += $isSwarmThinking ? 0.08 : 0.02;
            const pulse = Math.sin(pulseTime) * 0.5 + 0.5; // 0 to 1

            // Base size and opacity
            const baseRadius = $isSwarmThinking ? 600 : 400;
            const radius = baseRadius + pulse * 100;
            const opacity = $isSwarmThinking ? 0.4 : 0.15;

            // Clear black
            ctx.fillStyle = tokenRgba("scrim");
            ctx.fillRect(0, 0, width, height);

            // Create primary radial glow
            const gradient = ctx.createRadialGradient(
                mouseX,
                mouseY,
                0,
                mouseX,
                mouseY,
                radius,
            );

            if ($isSwarmThinking) {
                // Violet / Cyan active state
                gradient.addColorStop(0, tokenRgba("agent-fg", opacity + 0.2));
                gradient.addColorStop(0.4, tokenRgba("info-fg", opacity));
                gradient.addColorStop(1, tokenRgba("scrim", 0));
            } else {
                // Subtle cool white / blue idle state
                gradient.addColorStop(0, tokenRgba("fg", opacity));
                gradient.addColorStop(0.5, tokenRgba("accent-fg-strong", opacity * 0.5));
                gradient.addColorStop(1, tokenRgba("scrim", 0));
            }

            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, height);

            requestAnimationFrame(animate);
        }

        animate();
    });
</script>

<canvas
    bind:this={canvas}
    class="fixed inset-0 w-full h-full pointer-events-none z-behind bg-scrim"
></canvas>
