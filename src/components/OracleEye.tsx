"use client";

import { motion } from "framer-motion";

/**
 * 神谕之眼（2026-11-05 → 2026-11-06 视觉重设计 · 神谕页）
 *
 * ⚠️ 为什么是"眼"：
 *   "神谕"的本质是**被看见**（注视 / 洞察）——
 *   而水晶球是占卜的主视觉，神谕页需要**自己的**标识，
 *   否则两个页面会长得一样（用户分不清在哪）。
 *   → 眼 = 凝视 = 神谕的语义。
 *
 * ⚠️⚠️ 2026-11-06：改用 **AI 生成的神谕之眼**（SVG 版退役）
 *   SVG 版能做"杏仁形眼眶 + 虹膜"，但做不出：
 *     · 巴洛克卷草的**装饰层次**
 *     · 虹膜上同心环的**精细刻度**
 *     · 向外放射的**金色光芒**
 *   AI 图全有 → 华丽度差一个量级。
 *
 * ⚠️ 为什么用 mix-blend-mode: screen：
 *   AI 图背景是纯黑 → 直接叠会在紫底上出现黑方块。
 *   screen 混合让黑底消失（黑 = 0，不改变底色）。
 *
 * ⚠️ active（思考中）：
 *   光晕增强 + 缓慢旋转 → 用户能看出"它在想"。
 *   这是**状态反馈**，不是装饰。
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
        className="absolute -inset-8 rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(212,175,55,0.26) 0%, rgba(139,92,246,0.12) 42%, transparent 70%)",
          filter: "blur(16px)",
        }}
        animate={{
          opacity: active ? [0.55, 1, 0.55] : [0.45, 0.78, 0.45],
          scale: active ? [0.95, 1.06, 0.95] : 1,
        }}
        transition={{ duration: active ? 2.2 : 4.5, repeat: Infinity, ease: "easeInOut" }}
      />

      {/**
       * ---- AI 生成的神谕之眼 ----
       * ⚠️ 为什么用 screen 而不是直接叠：
       *   AI 图的黑底会变成紫背景上的**黑色方块**。
       *   screen 混合：黑(0) 对底色无影响 → 黑底自动消失。
       * ⚠️ 为什么 active 时旋转：
       *   静态图 + 静态页面 = 用户不知道"它在思考" → 旋转是明确的状态信号。
       */}
      <motion.div
        className="absolute inset-0 flex items-center justify-center"
        animate={{ rotate: active ? 360 : 0 }}
        transition={{
          duration: active ? 14 : 0,
          repeat: active ? Infinity : 0,
          ease: "linear",
        }}
      >
        {/**
         * ⚠️ 眨眼（2026-11-06 · 用户要求"可以眨眼睛"）
         * ⚠️ 实现：用 scaleY 做"睁开 → 闭合 → 睁开"的循环。
         * ⚠️ 为什么不用 clip-path 的椭圆：
         *   椭圆裁剪要 4 个控制点，反而更复杂；
         *   scaleY 的"上下眼皮合拢"更接近真实眨眼。
         * ⚠️ 节奏设计：
         *   大部分时间睁着，偶尔眨一下（人眼的自然节奏）；
         *   active（思考中）眨眼更频繁 → 有"正在观察"的紧迫感。
         */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <motion.img
          src="/images/celestial/oracle-eye.webp"
          alt=""
          className="w-full h-full object-contain pointer-events-none"
          style={{
            filter:
              "drop-shadow(0 0 18px rgba(212,175,55,0.45)) drop-shadow(0 0 40px rgba(139,92,246,0.30))",
            transformOrigin: "center center",
          }}
          animate={{ scaleY: [1, 1, 0.06, 1, 1] }}
          transition={{
            duration: active ? 2.8 : 4.6,
            times: [0, 0.80, 0.86, 0.92, 1],
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      </motion.div>
    </div>
  );
}
