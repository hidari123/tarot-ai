"use client";

import { motion, useMotionValue, useSpring } from "framer-motion";
import { useRef } from "react";

/**
 * 占卜水晶球 · 动态版（2026-11-06）
 *
 * ⚠️ 用户给的参考图（紫发神谕师手捧水晶球）：
 *   关键特征不是"球"，而是**球里的活**：
 *     · 内部有星云在**流动/旋转**（不是静态贴图）
 *     · 球心有一个**炽烈的光源**在呼吸
 *     · 玻璃表面有**流动的高光**
 *     · 球体随鼠标**视差**位移
 *   → 用 CSS/JS 实现这四层动态，而不是靠"把一张图做成 GIF"。
 *
 * ⚠️ 为什么不用 GIF / 视频：
 *   · GIF 无法响应鼠标
 *   · 视频体积大且要等加载
 *   → framer-motion + CSS 动画：零额外流量、可交互、可降级。
 *
 * ⚠️ 为什么球心要有"炽烈光源"：
 *   没有它，球就是"一个发光的球体"；
 *   有了它，球就是"**里面有什么在燃烧**"——有生命力、有方向感。
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

      {/* ---- 玻璃球体（AI 素材 + 动态高光） ----
           ⚠️ 为什么球体的静态图放在最下层：
             动态层（内部星云旋转、核心光、流动高光）都要画在它上面。 */}
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
            filter: "drop-shadow(0 0 46px rgba(139,92,246,0.45))",
          }}
        />
      </motion.div>

      {/**
       * ---- 动态层 ①：内部星云环（旋转 + 反向双层）----
       * ⚠️ 为什么用 conic-gradient 而不是图片：
       *   参考图的"流动感"来自**螺旋状的色带**在转 →
       *   conic-gradient 天然就是螺旋色带（角度渐变）。
       *   两层反向旋转 → 产生"星系相对运动"的错觉。
       */}
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "16%",
          top: "12%",
          width: "68%",
          height: "68%",
          borderRadius: "50%",
          background:
            "conic-gradient(from 0deg, rgba(216,180,254,0.00) 0deg, rgba(216,180,254,0.55) 40deg, rgba(129,140,248,0.30) 120deg, rgba(216,180,254,0.00) 200deg, rgba(192,132,252,0.42) 280deg, rgba(216,180,254,0.00) 360deg)",
          filter: "blur(9px)",
          mixBlendMode: "screen",
          opacity: 0.62,
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 24, repeat: Infinity, ease: "linear" }}
      />
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "24%",
          top: "20%",
          width: "52%",
          height: "52%",
          borderRadius: "50%",
          background:
            "conic-gradient(from 180deg, rgba(59,130,246,0.00) 0deg, rgba(59,130,246,0.40) 90deg, rgba(59,130,246,0.00) 190deg, rgba(217,119,6,0.28) 290deg, rgba(59,130,246,0.00) 360deg)",
          filter: "blur(11px)",
          mixBlendMode: "screen",
          opacity: 0.5,
        }}
        animate={{ rotate: -360 }}
        transition={{ duration: 36, repeat: Infinity, ease: "linear" }}
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
          width: "26%",
          height: "26%",
          marginLeft: "-13%",
          marginTop: "-13%",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(255,255,255,0.98) 0%, rgba(240,217,138,0.72) 22%, rgba(196,181,253,0.34) 46%, transparent 72%)",
          filter: "blur(1px)",
          mixBlendMode: "screen",
        }}
        animate={{ scale: [0.9, 1.22, 0.9], opacity: [0.75, 1, 0.75] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      />
      {/* 核心的扩散光晕 */}
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "50%",
          top: "42%",
          width: "52%",
          height: "52%",
          marginLeft: "-26%",
          marginTop: "-26%",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(196,181,253,0.34) 0%, rgba(139,92,246,0.14) 40%, transparent 68%)",
          filter: "blur(12px)",
          mixBlendMode: "screen",
        }}
        animate={{ scale: [1, 1.18, 1], opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      />

      {/**
       * ---- 动态层 ③：流动高光（沿球面游走）----
       * ⚠️ 为什么高光要"动"：
       *   静态高光 = 一块死白斑；游走的高光 = 玻璃在反光。
       */}
      <motion.div
        className="absolute pointer-events-none"
        style={{
          left: "14%",
          top: "10%",
          width: "34%",
          height: "24%",
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at 40% 40%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.12) 46%, transparent 70%)",
          filter: "blur(6px)",
          mixBlendMode: "screen",
        }}
        animate={{
          x: [0, 16, 4, 0],
          y: [0, 8, 18, 0],
          opacity: [0.75, 0.5, 0.85, 0.75],
        }}
        transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* ---- 动态层 ④：上升的星尘（从球底升起） ---- */}
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="absolute pointer-events-none rounded-full"
          style={{
            left: `${38 + i * 8}%`,
            bottom: "30%",
            width: 2.4,
            height: 2.4,
            background: "rgba(255,255,255,0.9)",
            boxShadow: "0 0 6px rgba(216,180,254,0.9)",
          }}
          animate={{ y: [0, -70], opacity: [0, 0.9, 0] }}
          transition={{
            duration: 5 + i * 0.9,
            repeat: Infinity,
            delay: i * 1.3,
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
