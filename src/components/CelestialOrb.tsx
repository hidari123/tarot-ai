"use client";

import { motion, useMotionValue, useSpring } from "framer-motion";
import { useRef } from "react";

/**
 * 占卜水晶球 · 动态版（2026-11-06）
 *
 * ⚠️ 用户参考图：紫发神谕师**手从下面托着**水晶球
 *   要求："手在下面拖着、不要太写实、透明底"。
 *
 * ⚠️⚠️ 为什么静态图不够：
 *   参考图的"活"来自四层叠加，静态图只有一层：
 *     · 内部有星云在**流动/旋转**（不是静态贴图）
 *     · 球心有一个**炽烈的光源**在呼吸
 *     · 玻璃表面有**流动的高光**
 *     · 球体随鼠标**视差**位移
 *   → 用 CSS/JS 实现这四层，而不是把静态图做成 GIF。
 *
 * ⚠️ 为什么不用 GIF / 视频：
 *   · GIF 无法响应鼠标
 *   · 视频体积大且要等加载
 *   → framer-motion + CSS 动画：零额外流量、可交互、可降级。
 */
export default function CelestialOrb({
  size = 230,
  /** 鼠标跟随的最大偏移（px） */
  parallax = 8,
  className = "",
}: {
  size?: number;
  parallax?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 55, damping: 16, mass: 0.7 });
  const sy = useSpring(my, { stiffness: 55, damping: 16, mass: 0.7 });

  return (
    <motion.div
      ref={ref}
      className={`relative select-none ${className}`}
      style={{ width: size, height: size }}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        mx.set(((e.clientX - r.left) / r.width - 0.5) * parallax);
        my.set(((e.clientY - r.top) / r.height - 0.5) * parallax);
      }}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      animate={{ scale: [1, 1.018, 1] }}
      transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
    >
      {/* ---- 外层光晕（呼吸 + 随鼠标偏移 → 有"空间感"） ---- */}
      <motion.div
        className="absolute -inset-10 rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(139,92,246,0.42) 0%, rgba(109,40,217,0.18) 44%, transparent 72%)",
          filter: "blur(28px)",
          x: sx,
          y: sy,
        }}
        animate={{ opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut" }}
      />

      {/**
       * ---- AI 水晶球（主体）----
       * ⚠️ 素材已用 sharp 抠成**透明底**（亮度转 alpha）→ 直接叠即可，
       *   不需要 mix-blend-mode（那会污染整个背景）。
       */}
      <motion.div
        className="absolute inset-0 flex items-center justify-center"
        style={{ x: sx, y: sy }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/celestial/orb-crystal.webp"
          alt="水晶球"
          className="w-full h-full object-contain pointer-events-none"
          style={{
            filter: "drop-shadow(0 0 40px rgba(139,92,246,0.42))",
          }}
        />
      </motion.div>

      {/**
       * ---- 动态层 ①：球内的螺旋星云（只覆盖球体区域）----
       * ⚠️ 为什么定位在 top 42% / left 50%：
       *   手捧图里球在**画面中心偏上**（球心约在 42% 高度处）。
       *   → 动态层必须跟着球心走，否则光会浮在手上。
       * ⚠️ 为什么用 conic-gradient：
       *   角度渐变天然是螺旋色带 → 旋转它 = 螺旋在转 = 星云流动感。
       *   两层反向 + 不同周期 → 相对运动 → 看不出规律。
       */}
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "50%",
          top: "42%",
          width: "38%",
          height: "38%",
          marginLeft: "-19%",
          marginTop: "-19%",
          borderRadius: "50%",
          background:
            "conic-gradient(from 0deg, rgba(216,180,254,0) 0deg, rgba(216,180,254,0.55) 45deg, rgba(129,140,248,0.32) 130deg, rgba(216,180,254,0) 220deg, rgba(192,132,252,0.45) 300deg, rgba(216,180,254,0) 360deg)",
          filter: "blur(7px)",
          mixBlendMode: "screen",
          opacity: 0.55,
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "50%",
          top: "42%",
          width: "28%",
          height: "28%",
          marginLeft: "-14%",
          marginTop: "-14%",
          borderRadius: "50%",
          background:
            "conic-gradient(from 160deg, rgba(59,130,246,0) 0deg, rgba(59,130,246,0.45) 100deg, rgba(59,130,246,0) 210deg, rgba(217,119,6,0.30) 300deg, rgba(59,130,246,0) 360deg)",
          filter: "blur(9px)",
          mixBlendMode: "screen",
          opacity: 0.45,
        }}
        animate={{ rotate: -360 }}
        transition={{ duration: 27, repeat: Infinity, ease: "linear" }}
      />

      {/**
       * ---- 动态层 ②：核心光源（炽烈 + 呼吸）----
       * ⚠️ 为什么必须有：
       *   参考图最抓人的就是球心那个"燃烧"的白光。
       *   没有它 → 球只是"半透明壳"；有了它 → 球**有中心、有方向、有生命**。
       */}
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "50%",
          top: "42%",
          width: "16%",
          height: "16%",
          marginLeft: "-8%",
          marginTop: "-8%",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,255,255,0.98) 0%, rgba(240,217,138,0.70) 26%, rgba(196,181,253,0.30) 50%, transparent 74%)",
          filter: "blur(1px)",
          mixBlendMode: "screen",
        }}
        animate={{ scale: [0.9, 1.25, 0.9], opacity: [0.8, 1, 0.8] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* 核心的扩散光晕 */}
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "50%",
          top: "42%",
          width: "40%",
          height: "40%",
          marginLeft: "-20%",
          marginTop: "-20%",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(196,181,253,0.30) 0%, rgba(139,92,246,0.12) 42%, transparent 68%)",
          filter: "blur(12px)",
          mixBlendMode: "screen",
        }}
        animate={{ scale: [1, 1.18, 1], opacity: [0.55, 0.9, 0.55] }}
        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
      />

      {/**
       * ---- 动态层 ③：流动高光（沿球面游走）----
       * ⚠️ 为什么高光要"动"：
       *   静态高光 = 一块死白斑；游走的高光 = 玻璃在反光。
       */}
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "40%",
          top: "28%",
          width: "18%",
          height: "12%",
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at 40% 40%, rgba(255,255,255,0.52) 0%, rgba(255,255,255,0.10) 48%, transparent 72%)",
          filter: "blur(5px)",
          mixBlendMode: "screen",
        }}
        animate={{
          x: [0, 12, 3, 0],
          y: [0, 6, 14, 0],
          opacity: [0.7, 0.45, 0.8, 0.7],
        }}
        transition={{ duration: 13, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* ---- 动态层 ④：上升的星尘（从球里升起） ---- */}
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="absolute pointer-events-none rounded-full"
          style={{
            left: `${45 + i * 5}%`,
            top: "44%",
            width: 2.2,
            height: 2.2,
            background: "rgba(255,255,255,0.9)",
            boxShadow: "0 0 6px rgba(216,180,254,0.9)",
          }}
          animate={{ y: [0, -52], opacity: [0, 0.9, 0] }}
          transition={{
            duration: 4.5 + i * 0.9,
            repeat: Infinity,
            delay: i * 1.4,
            ease: "easeOut",
          }}
        />
      ))}

      {/* ---- 底部投影 ---- */}
      <motion.div
        className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-[46%] h-[7px] rounded-[50%] pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse, rgba(139,92,246,0.50) 0%, rgba(88,28,135,0.22) 45%, transparent 72%)",
          filter: "blur(6px)",
        }}
        animate={{ opacity: [0.75, 1, 0.75], scaleX: [0.94, 1.06, 0.94] }}
        transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut" }}
      />
    </motion.div>
  );
}
