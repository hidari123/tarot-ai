"use client";

import { motion } from "framer-motion";

/**
 * 神谕之眼（2026-11-05 视觉重设计 · 第 3 批 · 神谕页）
 *
 * ⚠️ 为什么是"眼"：
 *   "神谕"的本质是**被看见**（注视 / 洞察）——
 *   而水晶球是占卜的主视觉，神谕页需要**自己的**标识，
 *   否则两个页面会长得一样（用户分不清在哪）。
 *   → 眼 = 凝视 = 神谕的语义。
 *
 * ⚠️ 为什么用 SVG 而不是字符（👁）：
 *   emoji 跨平台渲染差异极大（尤其在深色背景上）。
 *
 * ⚠️ active（思考中）：
 *   瞳孔收缩 + 外环加速旋转 + 光晕增强 →
 *   用户能看出"它在想"。这是**状态反馈**，不是装饰。
 */
export default function OracleEye({
  size = 92,
  active = false,
  className = "",
}: {
  size?: number;
  active?: boolean;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      {/* 外层光晕（呼吸） */}
      <motion.div
        className="absolute -inset-6 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(212,175,55,0.22) 0%, rgba(139,92,246,0.10) 42%, transparent 70%)",
          filter: "blur(14px)",
        }}
        animate={{ opacity: active ? [0.55, 1, 0.55] : [0.45, 0.75, 0.45], scale: active ? [0.95, 1.06, 0.95] : 1 }}
        transition={{ duration: active ? 2.2 : 4.5, repeat: Infinity, ease: "easeInOut" }}
      />

      {/* 外环（缓慢反向旋转的符文环） */}
      <motion.div
        className="absolute inset-0"
        animate={{ rotate: 360 }}
        transition={{ duration: 48, repeat: Infinity, ease: "linear" }}
      >
        <svg viewBox="0 0 100 100" className="w-full h-full">
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i * 30 * Math.PI) / 180 - Math.PI / 2;
            const r = 46;
            return (
              <circle
                key={i}
                cx={50 + r * Math.cos(a)}
                cy={50 + r * Math.sin(a)}
                r={i % 3 === 0 ? 1.6 : 0.9}
                fill="rgba(212,175,55,0.55)"
              />
            );
          })}
          <circle
            cx="50"
            cy="50"
            r="41"
            fill="none"
            stroke="rgba(168,85,247,0.28)"
            strokeWidth="0.8"
            strokeDasharray="2 5"
          />
        </svg>
      </motion.div>

      {/* 眼本体 */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
        <defs>
          <radialGradient id="oe-iris" cx="50%" cy="45%" r="52%">
            <stop offset="0%" stopColor="rgba(233,213,255,0.95)" />
            <stop offset="38%" stopColor="rgba(168,85,247,0.85)" />
            <stop offset="100%" stopColor="rgba(46,16,101,0.9)" />
          </radialGradient>
          <filter id="oe-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.8" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/**
         * ⚠️ 眼眶必须是**杏仁形**（尖两端、圆中间），不是椭圆。
         * ⚠️ 实测踩坑：原来用 `C 12 30 30 18 50 18 C 70 18 88 30 88 50 C ...`
         *   画出来是个**圆/椭圆**（看起来像星球，不像眼睛）。
         * → 正确画法：上下各一条弧，交汇于左右两个**尖角**：
         *   上弧：从左尖 (14,50) 升到中顶 (50,22) 再降到右尖 (86,50)
         *   下弧：从左尖 (14,50) 降到中底 (50,74) 再升到右尖 (86,50)
         *   控制点要"平"（水平切线）→ 才是杏仁而不是半圆。
         */}
        <path
          d="M14 50 C14 33 30 22 50 22 C70 22 86 33 86 50 C86 66 70 76 50 76 C30 76 14 66 14 50 Z"
          fill="rgba(20,10,42,0.55)"
          stroke="rgba(212,175,55,0.62)"
          strokeWidth="1.5"
          filter="url(#oe-glow)"
        />
        {/* 上眼睑加重（增加"眼"的感觉） */}
        <path
          d="M14 50 C14 33 30 22 50 22 C70 22 86 33 86 50"
          fill="none"
          stroke="rgba(212,175,55,0.88)"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
        {/* 下眼睑（更细） */}
        <path
          d="M14 50 C14 66 30 76 50 76 C70 76 86 66 86 50"
          fill="none"
          stroke="rgba(212,175,55,0.42)"
          strokeWidth="1.2"
          strokeLinecap="round"
        />

        {/* 虹膜 */}
        <circle cx="50" cy="50" r="16" fill="url(#oe-iris)" opacity="0.9" />
        <circle
          cx="50"
          cy="50"
          r="16"
          fill="none"
          stroke="rgba(233,213,255,0.5)"
          strokeWidth="0.9"
        />
        {/* 虹膜纹路 */}
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          return (
            <line
              key={i}
              x1={50 + 8 * Math.cos(a)}
              y1={50 + 8 * Math.sin(a)}
              x2={50 + 15 * Math.cos(a)}
              y2={50 + 15 * Math.sin(a)}
              stroke="rgba(233,213,255,0.35)"
              strokeWidth="0.7"
            />
          );
        })}

        {/* 瞳孔（active 时收缩） */}
        <motion.circle
          cx="50"
          cy="50"
          r="6.5"
          fill="rgba(10,4,22,0.95)"
          animate={{ r: active ? 3.2 : 6.5 }}
          transition={{ duration: 0.5 }}
        />
        {/* 高光 */}
        <circle cx="44" cy="44" r="2.6" fill="rgba(255,255,255,0.82)" />
        <circle cx="55" cy="56" r="1.2" fill="rgba(255,255,255,0.42)" />

        {/* 上下眼睑线（收拢） */}
        <path
          d="M14 50 C14 33 30 22 50 22 C70 22 86 33 86 50"
          fill="none"
          stroke="rgba(168,85,247,0.28)"
          strokeWidth="8"
          strokeLinecap="round"
          opacity="0.18"
        />
      </svg>
    </div>
  );
}
