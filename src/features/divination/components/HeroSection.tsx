"use client";

import { motion } from "framer-motion";

/**
 * HeroSection —— 首页标题与副标题（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么单独抽出来：
 *   · 它是整个页面的**视觉锚点**（用户第一眼看到的东西）
 *   · 字号/字间距全靠 CSS 变量（`--font-title` / `--font-sub` / `--tracking-*`）
 *     → **不依赖任何 state** → 天然独立、可单独调样式 ✅
 *
 * ⚠️ 尺寸全部乘全局缩放系数 `--u`（由 ViewportScale 写入）
 *   → 任意视口下，文字与背景图等比缩放 → 构图比例永远一致 ✅
 */
export default function HeroSection() {
  return (
    <>
      {/* ══════════════════════════════════════════════
       * 品牌标志（2026-11-18 · MOIRA）
       * ⚠️ 用 <img> 而不是内联 SVG：
       *   · SVG 文件已描摹好（1.6KB），改动时不用碰组件
       *   · <img> 的 alt 文本对屏幕阅读器更友好
       * ⚠️ 尺寸乘 --u → 和标题等比缩放 ✅
       */}
      <motion.img
        src="/images/brand/moira-mark.svg"
        alt="MOIRA"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1.1, ease: "easeOut" }}
        className="relative z-10 mx-auto mb-2 block select-none"
        style={{
          width: "calc(58px * var(--u, 1))",
          height: "calc(58px * var(--u, 1))",
          filter: "drop-shadow(0 0 14px rgba(212,175,55,0.35))",
        }}
        draggable={false}
      />

      {/* 标题 */}
      <motion.h1
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="relative z-10 text-shimmer tracking-[0.3em] select-none text-center"
        style={{
          fontFamily: "Cinzel, Georgia, serif",
          /**
           * ⚠️⚠️ 字号 = `--font-title` × `--u`
           * · 桌面端 --font-title: 75px（原 60px × 1.25）→ 随 --u 等比缩放 ✅
           * · 移动端 --font-title: 34px（媒体查询覆盖）→ **不再溢出屏幕** ✅
           */
          fontSize: "calc(var(--font-title, 75px) * var(--u, 1))",
          /**
           * ⚠️ 移动端字间距收窄（用户要求「一行放不下 需要居中展示」）
           * · 桌面端 0.3em 在 414px 屏上太宽 → 放不下
           * · 移动端用 0.14em → 「MYSTIC TAROT」能放下
           *   → 仍放不下时（更窄的屏）→ 由 `.title-line` 换行并居中 ✅
           */
          letterSpacing: "var(--tracking-title, 0.3em)",
        }}
      >
        {/*
         * ⚠️⚠️ 标题（2026-11-18 品牌更名：MYSTIC TAROT → MOIRA）
         * · MOIRA = 希腊神话中的命运女神 → 与「AI 占卜师」定位精准对应
         * · 标题分成两段（用户要求「移动端大标题如果一行放不下 需要居中展示」）
         *   · 桌面端：inline → 一行
         *   · 移动端：block → 放不下时自然分两行，且**居中**
         * ⚠️ 为什么不用 <br />：桌面端也会换行
         */}
        <span className="title-line">MOIRA</span>
        <span className="title-line">TAROT</span>
      </motion.h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4, duration: 0.8 }}
        className="relative z-10 mt-3 text-purple-200/75 text-center"
        style={{
          fontFamily: "'Ma Shan Zheng', serif",
          /** ⚠️ 字号 = `--font-sub` × `--u`（桌面 25px / 移动端 17px） */
          fontSize: "calc(var(--font-sub, 25px) * var(--u, 1))",
          /** ⚠️ 字间距也用变量（移动端更紧，两行才放得下） */
          letterSpacing: "var(--tracking-sub, 0.18em)",
        }}
      >
        {/*
         * ⚠️⚠️ 副标题**分两行**（用户要求：「副标题需要分成两行展示」）
         * · 用两个 <span>，靠 CSS 切换布局：
         *   · 桌面端：inline → 「倾听星辰的低语 · 窥探命运的轨迹」一行
         *   · 移动端：block → 自然分成两行
         * ⚠️ 为什么不用 <br />：
         *   · <br /> 在桌面端也会换行 → 桌面端变两行（不想要）
         *   · display:none 隐藏 <br /> → 两段文字粘连（没间隔）
         * → span + 媒体查询切换 display ✅
         */}
        <span className="sub-line whitespace-nowrap">倾听星辰的低语</span>
        <span className="sub-line whitespace-nowrap">
          <span className="hidden md:inline"> · </span>窥探命运的轨迹
        </span>
      </motion.p>
    </>
  );
}
