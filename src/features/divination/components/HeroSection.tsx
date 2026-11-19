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
      {/* ══════════════════════════════════════════════
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
           * · 桌面端 --font-title: 75px → 随 --u 等比缩放 ✅
           * · 移动端 --font-title: 34px（媒体查询覆盖）→ 不再溢出屏幕 ✅
           */
          fontSize: "calc(var(--font-title, 75px) * var(--u, 1))",
          /**
           * ⚠️ 移动端字间距收窄（用户要求「一行放不下 需要居中展示」）
           * · 桌面端 0.3em 在 414px 屏上太宽 → 放不下
           * · 移动端用 0.14em → 「MOIRA」能放下 ✅
           */
          letterSpacing: "var(--tracking-title, 0.3em)",
          /**
           * ⚠️ 暗色描边（2026-11-18）
           * ⚠️ 标题会压在小女孩的帽檐上 → 加光晕保证任何背景上都清楚
           */
          textShadow:
            "0 2px 14px rgba(8,4,20,0.9), 0 0 32px rgba(8,4,20,0.75), 0 0 56px rgba(140,80,220,0.4)",
        }}
      >
        {
        /*
         * ⚠️⚠️ 标题（2026-11-18 品牌更名：MYSTIC TAROT → MOIRA）
         * · MOIRA = 希腊神话中的命运女神 → 与「AI 占卜师」定位精准对应
         * ⚠️ 为什么用**字体**而不是 lockup 图片：
         *   · 字体有 text-shimmer 流光效果 → 图片没有
         *   · 字体可随 --u 无级缩放，且能跟随移动端字距收窄
         *   · 2026-11-18 曾试过 lockup 图 → 视觉上不如字体精致 ❌
         */}
        <span className="title-line">MOIRA</span>
      </motion.h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4, duration: 0.8 }}
        className="relative z-10 mt-1 text-purple-200/75 text-center"
        style={{
          fontFamily: "'Ma Shan Zheng', serif",
          /** ⚠️ 字号 = `--font-sub` × `--u`（桌面 25px / 移动端 17px） */
          fontSize: "calc(var(--font-sub, 25px) * var(--u, 1))",
          /** ⚠️ 字间距也用变量（移动端更紧，两行才放得下） */
          letterSpacing: "var(--tracking-sub, 0.18em)",
          /**
           * ⚠️⚠️ 暗色描边（2026-11-18）
           * ⚠️ 问题：副标题会**横穿小女孩的脸**（实测脸部 y=139~319，副标题 y=160~195）
           *   → 白字压在皮肤上 → 糊成一片看不清 ❌
           * ⚠️ 为什么用描边而不是把人物下移：
           *   · 动 `--orb-shift` 会连带影响球的位置和所有动效坐标
           *   · 用户明确要「人物和水晶球还是想在上面」→ 不想动构图
           *   → 描边是**零布局风险**的解法 ✅
           * ⚠️ 为什么用 text-shadow 而不是 -webkit-text-stroke：
           *   · stroke 会让字变粗、失去书法体的纤细感
           *   · shadow 是「光晕」→ 反而强化了占卜氛围 ✅
           */
          textShadow:
            "0 1px 10px rgba(8,4,20,0.95), 0 0 26px rgba(8,4,20,0.85), 0 0 44px rgba(120,60,200,0.35)",
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
