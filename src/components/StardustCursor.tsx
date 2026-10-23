"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 星尘光标 —— 淡紫白发光灵球 + canvas 星尘拖尾
 *
 * - 全局 cursor: none，DOM 灵球（径向渐变发光）rAF 插值跟随
 * - canvas 粒子拖尾：按移动速度生成星尘，渐隐渐小，轻微重力下坠
 * - 悬停可交互元素（button/a/input/[data-cursor-hover]）灵球放大
 * - prefers-reduced-motion / 触屏：回退默认光标
 */
export default function StardustCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (coarse || reduced) return;
    setEnabled(true);
    document.documentElement.classList.add("has-stardust-cursor");
    return () => document.documentElement.classList.remove("has-stardust-cursor");
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const dot = dotRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    let mx = -100, my = -100;
    let dx = -100, dy = -100;
    let hovering = false;
    let raf = 0;
    let last = performance.now();
    const particles: {
      x: number; y: number; vx: number; vy: number;
      life: number; maxLife: number; size: number; hue: number;
    }[] = [];

    const resize = () => {
      canvas.width = window.innerWidth * devicePixelRatio;
      canvas.height = window.innerHeight * devicePixelRatio;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const onMove = (e: MouseEvent) => {
      const prevX = mx, prevY = my;
      mx = e.clientX; my = e.clientY;
      if (prevX < 0) { dx = mx; dy = my; }

      const dist = Math.hypot(mx - prevX, my - prevY);
      const count = Math.min(Math.floor(dist / 6) + 1, 5);
      for (let i = 0; i < count; i++) {
        const t = i / count;
        particles.push({
          x: prevX + (mx - prevX) * t + (Math.random() - 0.5) * 6,
          y: prevY + (my - prevY) * t + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 0.6,
          vy: (Math.random() - 0.5) * 0.6 + 0.15,
          life: 0,
          maxLife: 40 + Math.random() * 35,
          size: 1 + Math.random() * 1.8,
          hue: 260 + Math.random() * 40,
        });
      }
      if (particles.length > 260) particles.splice(0, particles.length - 260);
    };

    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      hovering = !!t.closest("button, a, input, textarea, [data-cursor-hover]");
    };

    const loop = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;

      dx += (mx - dx) * 0.22;
      dy += (my - dy) * 0.22;
      const scale = hovering ? 1.7 : 1;
      dot.style.transform = `translate(${dx}px, ${dy}px) translate(-50%, -50%) scale(${scale})`;

      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt / 16.7;
        if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.985; p.vy = p.vy * 0.985 + 0.008;
        const k = 1 - p.life / p.maxLife;
        const alpha = k * 0.85;
        const size = p.size * (0.4 + k * 0.6);
        ctx.beginPath();
        ctx.shadowBlur = 8;
        ctx.shadowColor = `hsla(${p.hue}, 90%, 80%, ${alpha})`;
        ctx.fillStyle = `hsla(${p.hue}, 95%, 88%, ${alpha})`;
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("mouseover", onOver, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseover", onOver);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <>
      <canvas ref={canvasRef} className="fixed inset-0 z-[9998] pointer-events-none" />
      <div
        ref={dotRef}
        className="fixed top-0 left-0 z-[9999] pointer-events-none w-3.5 h-3.5 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(255,255,255,0.98) 0%, rgba(233,213,255,0.9) 28%, rgba(196,148,255,0.45) 55%, rgba(147,86,250,0.12) 78%, transparent 100%)",
          boxShadow:
            "0 0 10px 2px rgba(216,180,254,0.65), 0 0 26px 6px rgba(168,85,247,0.30), 0 0 52px 14px rgba(126,58,242,0.16)",
          mixBlendMode: "screen",
        }}
      />
    </>
  );
}
