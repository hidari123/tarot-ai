"use client";

import { motion, useMotionValue, useSpring } from "framer-motion";
import { useRef } from "react";

/**
 * 占卜水晶球（2026-11-05 → 2026-11-06 视觉重设计 · 首页主视觉）
 *
 * ⚠️⚠️ 为什么首页需要"一个中心物"：
 *   之前首页是"标题 + 一堆选项"，所有元素权重相同 → 视线无处停留。
 *   而"占卜"这件事天然需要一个**视觉锚点**（水晶球 / 牌堆 / 蜡烛）。
 *   → 这个组件就是那个锚点：整页的重心。
 *
 * ⚠️⚠️ 2026-11-06：整体换成 **AI 生成的水晶球**（CSS 版本退役）
 *   之前用 CSS 渐变 + 模糊色团模拟，但 CSS 永远做不出三样东西：
 *     · 真实玻璃的**厚度感**与折射高光
 *     · 内部星云的**纤维结构**（渐变是纯色雾，没有走向）
 *     · 底座的**金属雕花**
 *   AI 图这三样全有 → 质感差一个量级。
 *   → 保留的只有 CSS 做不到的部分：**交互的"活着"感**（鼠标视差 + 呼吸）。
 *
 * ⚠️ 为什么用 mix-blend-mode: screen 叠图：
 *   AI 图的背景是**纯黑**（模型出图习惯）→ 直接叠会在紫背景上出现黑方块。
 *   → screen 混合：结果 = 1-(1-a)(1-b)，黑(0) 不改变底色 → 黑底自动消失。
 *   ⚠️ 为什么不用 mix-blend-mode: lighten：
 *   lighten 会保留最亮的通道 → 球的紫色会污染整个底图（screen 只在黑处透明）。
 *
 * ⚠️ 鼠标跟随视差：
 *   球体整体朝鼠标方向偏移（±6px）→ 产生"球在空间中"的立体错觉。
 *   幅度必须很小，否则显得廉价。
 */
export default function OracleOrb({
  size = 200,
  /** 鼠标跟随的最大偏移（px） */
  parallax = 6,
  className = "",
}: {
  size?: number;
  parallax?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 鼠标位置（归一化 -0.5 ~ 0.5）
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  // 弹簧跟随 → 有"跟随感"而不是"生硬跟随"
  const sx = useSpring(mx, { stiffness: 60, damping: 18, mass: 0.6 });
  const sy = useSpring(my, { stiffness: 60, damping: 18, mass: 0.6 });

  return (
    <motion.div
      ref={ref}
      className={`relative select-none ${className}`}
      style={{ width: size, height: size }}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        mx.set((e.clientX - r.left) / r.width - 0.5);
        my.set((e.clientY - r.top) / r.height - 0.5);
      }}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      animate={{ scale: [1, 1.015, 1] }}
      transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
    >
      {/**
       * ---- 外层光晕（呼吸）----
       * ⚠️ 画在图的**下方**且不被裁切 → 用 -inset-6 的径向渐变 + blur。
       * ⚠️ 之前踩过的坑（2026-11-05）：
       *   光晕如果是独立圆 div 且被 overflow-hidden 的球体裁切 →
       *   圆边会在球顶露出一道弧，像"戴帽子"。
       */}
      <div
        className="absolute -inset-8 rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(139,92,246,0.40) 0%, rgba(109,40,217,0.18) 42%, transparent 70%)",
          filter: "blur(26px)",
          animation: "orb-breathe 5.5s ease-in-out infinite",
        }}
      />

      {/**
       * ---- AI 水晶球（主体）----
       * ⚠️ 为什么内层再套一个 motion.div：
       *   视差位移要用 spring 的值（sx/sy），
       *   但外层已经有 scale 动画 → 两者放同一元素会互相覆盖 transform。
       *   → 分成两层：外层管缩放，内层管位移。
       */}
      <motion.div
        className="absolute inset-0 flex items-center justify-center"
        style={{ x: sx, y: sy }}
        animate={{ y: [0, -3, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/celestial/orb-crystal.webp"
          alt="水晶球"
          className="w-full h-full object-contain pointer-events-none"
          style={{
            filter: "drop-shadow(0 0 44px rgba(139,92,246,0.40))",
          }}
        />
      </motion.div>

      {/* ---- 内部星点（叠在球前 → 有"在玻璃里"的层次） ---- */}
      <div
        className="absolute inset-0 opacity-55 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(1.4px 1.4px at 44% 30%, rgba(255,255,255,0.85), transparent)," +
            "radial-gradient(1.2px 1.2px at 57% 24%, rgba(255,255,255,0.7), transparent)," +
            "radial-gradient(1.6px 1.6px at 61% 56%, rgba(233,213,255,0.8), transparent)," +
            "radial-gradient(1.1px 1.1px at 47% 62%, rgba(255,255,255,0.55), transparent)",
        }}
      />

      {/* ---- 底部投影（让球"落"在空间里） ---- */}
      <div
        className="absolute left-1/2 -bottom-1 -translate-x-1/2 w-[46%] h-[7px] rounded-[50%] pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse, rgba(139,92,246,0.50) 0%, rgba(88,28,135,0.22) 45%, transparent 72%)",
          filter: "blur(6px)",
        }}
      />
    </motion.div>
  );
}
