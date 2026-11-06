"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import TarotCardBack from "@/components/TarotCardBack";

/**
 * 塔罗牌框（2026-11-05 视觉重设计 · 第 2 批）
 *
 * ⚠️⚠️ 为什么需要这个组件（而不是各处直接写 `<img>`）：
 *   现在全站 5 个页面（每日/本周/月运/四季/年运 + 占卜牌阵）都直接贴牌面图，
 *   结果是**裸图** —— 没有边框、没有厚度、没有光效、悬停无反馈。
 *   → "牌"是占卜产品的核心视觉对象，它应该是全站**质感最高**的元素。
 *
 * ⚠️ 视觉层次（四层，从外到内）：
 *   ① 外发光（金色/紫色，随状态变化）
 *   ② 金色内描边 + 外框（让牌有"镶框"感，像博物馆藏品）
 *   ③ 牌面（略微内缩，四边有暗角 → 有"陷进去"的深度）
 *   ④ 悬停时的 3D 微倾斜 + 光泽扫过
 *
 * ⚠️ 逆位不只是旋转图片：
 *   逆位牌应该在**顶部有一个标记**（否则用户看到倒着的图会以为是 bug），
 *   且边框偏冷色 —— 让"正/逆"在缩略图尺寸也能区分。
 *
 * ⚠️ 为什么不用 3D 翻转（rotateY）做翻牌：
 *   翻转需要正反两面（牌背 + 牌面），而牌背图只有一张 78 拼图之外的素材，
 *   且 3D 翻转在移动端性能差。→ 这里只做**悬停的微倾斜**（transform 幅度 ±6°）。
 */

/** 牌框的色调 */
export type CardTone = "gold" | "violet" | "dim";

const TONES: Record<CardTone, { border: string; glow: string; inner: string }> = {
  gold: {
    border: "rgba(212,175,55,0.75)",
    glow: "0 0 26px rgba(212,175,55,0.30), 0 14px 40px rgba(0,0,0,0.55)",
    inner: "rgba(212,175,55,0.28)",
  },
  violet: {
    border: "rgba(168,85,247,0.65)",
    glow: "0 0 24px rgba(139,92,246,0.28), 0 14px 40px rgba(0,0,0,0.55)",
    inner: "rgba(168,85,247,0.22)",
  },
  // 未揭示的牌（牌背）
  dim: {
    border: "rgba(168,85,247,0.40)",
    glow: "0 0 16px rgba(139,92,246,0.16), 0 10px 28px rgba(0,0,0,0.45)",
    inner: "rgba(168,85,247,0.16)",
  },
};

export default function TarotCardFrame({
  src,
  alt,
  /** 是否逆位 */
  reversed = false,
  /** 色调 */
  tone = "violet",
  /** 宽度（px 或任意 CSS 长度） */
  width,
  /** 点击（放大预览） */
  onClick,
  /** 是否可交互（悬停效果） */
  interactive = true,
  /** 牌位名称（显示在下方） */
  label,
  className = "",
  style,
}: {
  src?: string;
  alt: string;
  reversed?: boolean;
  tone?: CardTone;
  width?: number | string;
  onClick?: () => void;
  interactive?: boolean;
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const t = TONES[tone];
  const w = typeof width === "number" ? `${width}px` : width;

  return (
    <div className={`group/card relative ${className}`} style={style}>
      {/* ① 牌面容器 */}
      <motion.div
        className="relative"
        style={{
          width: w,
          aspectRatio: "2 / 3",
          perspective: "900px",
          cursor: onClick ? "pointer" : undefined,
        }}
        onClick={onClick}
        onHoverStart={() => setHover(true)}
        onHoverEnd={() => setHover(false)}
        animate={
          interactive && hover
            ? { rotateX: -5, rotateY: 5, scale: 1.035, y: -4 }
            : { rotateX: 0, rotateY: 0, scale: 1, y: 0 }
        }
        transition={{ type: "spring", stiffness: 260, damping: 22 }}
      >
        {/* ② 外框（双色描边 → 有镶框感） */}
        <div
          className="absolute -inset-[3px] rounded-[14px] pointer-events-none"
          style={{
            border: `1.5px solid ${t.border}`,
            boxShadow: t.glow,
          }}
        />
        {/* 内描边 */}
        <div
          className="absolute inset-0 rounded-xl pointer-events-none z-10"
          style={{ boxShadow: `inset 0 0 0 1px ${t.inner}` }}
        />

        {/* ③ 牌面（内缩 + 暗角 → 有深度） */}
        <div className="absolute inset-0 overflow-hidden rounded-xl bg-[#0b0618]">
          {src ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={alt}
                className={`w-full h-full object-cover transition-transform duration-500 ${
                  reversed ? "rotate-180" : ""
                }`}
              />
              {/* 四边暗角 */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background:
                    "radial-gradient(ellipse at center, transparent 55%, rgba(6,3,14,0.45) 100%)",
                }}
              />
              {/* ④ 悬停光泽扫过 */}
              <div
                className="absolute inset-0 pointer-events-none opacity-0 group-hover/card:opacity-100 transition-opacity duration-500"
                style={{
                  background:
                    "linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.14) 46%, rgba(255,255,255,0.05) 54%, transparent 70%)",
                  transform: hover ? "translateX(0)" : "translateX(-30%)",
                  transition: "transform .7s cubic-bezier(.22,.61,.36,1)",
                }}
              />
            </>
          ) : (
            /* ⚠️ 2026-11-06：牌背纹样抽成独立组件（TarotCardBack）
               —— 它现在有三个使用方（牌框 / 水晶球 / 运势页），
               纹样是资产，不能复制三份。 */
            <TarotCardBack className="w-full h-full" />
          )}
        </div>

        {/* 逆位标记（让用户知道"这是逆位"，不是渲染错误） */}
        {reversed && src && (
          <div className="absolute top-2 right-2 z-20 px-1.5 py-0.5 rounded text-[9px] tracking-wider bg-[#0b0618]/85 border border-cyan-300/30 text-cyan-100/90">
            逆
          </div>
        )}
      </motion.div>

      {/* 牌名（衬线大字 + 微光） */}
      {label && (
        <p
          className="text-center mt-2.5 text-[15px] tracking-[0.18em] text-purple-50/90"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        >
          {label}
        </p>
      )}
    </div>
  );
}
