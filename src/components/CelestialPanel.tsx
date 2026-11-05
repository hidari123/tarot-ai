/**
 * 深空占卜室 · 玻璃面板（2026-11-05 视觉重设计 · 第 1 批）
 *
 * ⚠️ 为什么需要这个组件（而不是继续各写各的）：
 *   之前全站的面板是 `bg-purple-950/20 border border-white/8` ——
 *   一个**平**的半透明矩形（没有渐变、没有内高光、没有景深）→ 廉价感来源。
 *   玻璃拟态的关键是**三层**：
 *     ① 半透明渐变（不是纯色 —— 有方向感）
 *     ② 背景模糊（把后面的星云揉进去 → 面板"在空间里"）
 *     ③ 内高光（顶部一道亮边 → 面板有厚度）
 *   缺任何一层都会退回"贴纸"感。
 */

import type { ReactNode } from "react";

export type PanelTone = "violet" | "gold" | "neutral";

/** 三种色调的主色（对应品牌色阶） */
const TONES: Record<PanelTone, { border: string; glow: string; grad: string }> = {
  violet: {
    border: "rgba(168, 85, 247, 0.22)",
    glow: "0 0 34px rgba(139, 92, 246, 0.16)",
    grad: "linear-gradient(160deg, rgba(38, 24, 66, 0.62), rgba(10, 6, 22, 0.78))",
  },
  gold: {
    border: "rgba(212, 175, 55, 0.26)",
    glow: "0 0 34px rgba(212, 175, 55, 0.14)",
    grad: "linear-gradient(160deg, rgba(48, 38, 20, 0.55), rgba(12, 8, 20, 0.8))",
  },
  neutral: {
    border: "rgba(255, 255, 255, 0.08)",
    glow: "0 0 24px rgba(0, 0, 0, 0.35)",
    grad: "linear-gradient(160deg, rgba(28, 24, 44, 0.5), rgba(8, 6, 18, 0.74))",
  },
};

export default function CelestialPanel({
  children,
  tone = "violet",
  /** 内边距 */
  padding = "p-5",
  /** 圆角 */
  radius = "rounded-2xl",
  /** 是否有悬停微光 */
  interactive = false,
  className = "",
  style,
}: {
  children: ReactNode;
  tone?: PanelTone;
  padding?: string;
  radius?: string;
  interactive?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const t = TONES[tone];
  return (
    <div
      className={`relative ${radius} ${padding} ${interactive ? "transition-all duration-300 hover:-translate-y-0.5" : ""} ${className}`}
      style={{
        background: t.grad,
        backdropFilter: "blur(16px) saturate(1.2)",
        WebkitBackdropFilter: "blur(16px) saturate(1.2)",
        border: `1px solid ${t.border}`,
        boxShadow: `${t.glow}, 0 8px 40px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 面板的标题行（带一道发光竖线）
 *
 * ⚠️ 为什么标题要带竖线：
 *   纯居中/左对齐的标题没有"锚"，容易飘。
 *   一道金色竖线 = 视觉锚点，把标题和内容绑在一起。
 */
export function PanelTitle({
  children,
  tone = "gold",
  className = "",
}: {
  children: ReactNode;
  tone?: "gold" | "violet";
  className?: string;
}) {
  const color = tone === "gold" ? "#d4af37" : "#a78bfa";
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span
        className="w-[2px] h-4 rounded-full shrink-0"
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      />
      <h3 className="text-[13px] tracking-[0.18em] text-purple-100/85">{children}</h3>
    </div>
  );
}

/**
 * 关键词徽章（铜牌样式）
 *
 * ⚠️ 为什么要换掉原来的胶囊样式：
 *   `rounded-full border-purple-400/30 bg-purple-500/10` 是典型的"标签 UI"，
 *   看起来像后台管理系统，不像占卜。
 *   → 改成**菱形切角**（clip-path）+ 细金边 → 有"金属牌"的感觉。
 */
export function ArcaneTag({
  children,
  tone = "violet",
}: {
  children: ReactNode;
  tone?: "violet" | "gold";
}) {
  const border = tone === "gold" ? "rgba(212,175,55,0.45)" : "rgba(168,85,247,0.45)";
  const bg =
    tone === "gold"
      ? "linear-gradient(140deg, rgba(60,46,20,0.55), rgba(20,14,8,0.5))"
      : "linear-gradient(140deg, rgba(46,28,80,0.6), rgba(14,9,28,0.5))";
  const text = tone === "gold" ? "#e8c87a" : "#ddd6fe";
  return (
    <span
      className="inline-flex items-center px-2.5 py-[3px] text-[11px] tracking-wide"
      style={{
        color: text,
        border: `1px solid ${border}`,
        background: bg,
        clipPath: "polygon(5px 0, 100% 0, 100% calc(100% - 5px), calc(100% - 5px) 100%, 0 100%, 0 5px)",
      }}
    >
      {children}
    </span>
  );
}
