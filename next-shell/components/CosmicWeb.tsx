"use client";

import React, { useRef, useEffect } from 'react';

export default function CosmicWeb({ isPaused = false }: { isPaused?: boolean }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const isPausedRef = useRef(isPaused);

    useEffect(() => {
        isPausedRef.current = isPaused;
    }, [isPaused]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;
        let w: number, h: number;
        const nodes: Node[] = [];
        // Subtle, atmospheric density -> slightly increased
        const nodeCount = 220;
        const connectionDistance = 110;
        const mouse = { x: -1000, y: -1000 };

        class Node {
            x: number;
            y: number;
            vx: number;
            vy: number;
            radius: number;
            pulse: number;
            pulseSpeed: number;
            isNeuron: boolean;

            constructor() {
                this.x = Math.random() * w;
                this.y = Math.random() * h;
                // Slow, drifting movement (slightly faster)
                this.vx = (Math.random() - 0.5) * 0.25;
                this.vy = (Math.random() - 0.5) * 0.25;

                // Very few nodes are glowing neurons (slightly more)
                this.isNeuron = Math.random() > 0.90;
                this.radius = this.isNeuron ? Math.random() * 1.5 + 1 : Math.random() * 1 + 0.3;
                this.pulse = Math.random() * Math.PI;
                this.pulseSpeed = 0.01 + Math.random() * 0.02;
            }

            update() {
                this.x += this.vx;
                this.y += this.vy;
                this.pulse += this.pulseSpeed;

                if (this.x < 0 || this.x > w) this.vx *= -1;
                if (this.y < 0 || this.y > h) this.vy *= -1;
            }

            draw() {
                if (!ctx) return;
                const p = (Math.sin(this.pulse) + 1) / 2; // 0 to 1

                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);

                if (this.isNeuron) {
                    // Neuron glow
                    const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.radius * 4);
                    gradient.addColorStop(0, `rgba(180, 210, 255, ${0.4 + p * 0.4})`);
                    gradient.addColorStop(1, 'rgba(180, 210, 255, 0)');
                    ctx.fillStyle = gradient;
                    ctx.fill();

                    ctx.beginPath();
                    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(255, 255, 255, ${0.8 + p * 0.2})`;
                    ctx.fill();
                } else {
                    ctx.fillStyle = `rgba(255, 255, 255, ${0.2 + p * 0.3})`;
                    ctx.fill();
                }
            }
        }

        const init = () => {
            w = canvas.width = window.innerWidth;
            h = canvas.height = window.innerHeight;
            nodes.length = 0;
            for (let i = 0; i < nodeCount; i++) {
                nodes.push(new Node());
            }
        };

        const drawLines = () => {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const dx = nodes[i].x - nodes[j].x;
                    const dy = nodes[i].y - nodes[j].y;
                    const distSq = dx * dx + dy * dy;
                    const connSq = connectionDistance * connectionDistance;

                    if (distSq < connSq) {
                        const dist = Math.sqrt(distSq);
                        const opacity = (1 - dist / connectionDistance) * 0.4;
                        const p = (Math.sin(nodes[i].pulse + nodes[j].pulse) + 1) / 2;

                        ctx.beginPath();
                        ctx.moveTo(nodes[i].x, nodes[i].y);
                        ctx.lineTo(nodes[j].x, nodes[j].y);

                        // Blue-ish threads
                        ctx.strokeStyle = `rgba(140, 180, 255, ${opacity * (0.1 + p * 0.15)})`;
                        ctx.lineWidth = 0.4;
                        ctx.stroke();
                    }
                }

                // Mouse interaction
                const dx = nodes[i].x - mouse.x;
                const dy = nodes[i].y - mouse.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < 40000) { // 200px
                    const dist = Math.sqrt(distSq);
                    const opacity = 1 - dist / 200;
                    ctx.beginPath();
                    ctx.moveTo(nodes[i].x, nodes[i].y);
                    ctx.lineTo(mouse.x, mouse.y);
                    ctx.strokeStyle = `rgba(255, 255, 255, ${opacity * 0.15})`;
                    ctx.lineWidth = 0.6;
                    ctx.stroke();
                }
            }
        };

        const animate = () => {
            if (!isPausedRef.current) {
                ctx.clearRect(0, 0, w, h);

                // Subtle ambient noise/stars
                nodes.forEach(node => {
                    node.update();
                    node.draw();
                });
                drawLines();
            }
            animationFrameId = requestAnimationFrame(animate);
        };

        window.addEventListener('resize', init);
        window.addEventListener('mousemove', (e) => {
            mouse.x = e.clientX;
            mouse.y = e.clientY;
        });

        init();
        animate();

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('resize', init);
        };
    }, []);

    return (
        <canvas
            ref={canvasRef}
            className="fixed inset-0 pointer-events-none"
            style={{
                zIndex: -1,
                background: 'radial-gradient(circle at center, #0a0a20 0%, #020205 100%)'
            }}
        />
    );
}
