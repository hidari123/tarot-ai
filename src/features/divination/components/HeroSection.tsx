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
       * 品牌标志 + 标题（2026-11-18 · MOIRA）
       *
       * ⚠️⚠️ 为什么用**一张 lockup 图**而不是「图标 + 文字标题」两行：
       *   · 用户要求：「中间的也要图标+文字的那个logo吧 不要这样分成两行了 占地方」
       *   · 字体渲染的 MOIRA 和 logo 里的月亮**不是同一个设计** → 拼一起像两套东西
       *   · 用同一张图 → 视觉完全统一 + 只占一行 ✅
       *
       * ⚠️ 尺寸乘 --u → 和整体等比缩放 ✅
       * ⚠️ 宽度按 lockup 原比例（879×240 → 高是宽的 0.273）→ 不写死高度，
       *   用 height:auto 让浏览器按比例算 ✅
       */}
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 1, ease: "easeOut" }}
        className="relative z-10 flex justify-center"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/brand/moira-lockup.webp"
          alt="MOIRA"
          className="select-none"
          style={{
            width: "calc(340px * var(--u, 1))",
            height: "auto",
            filter: "drop-shadow(0 0 20px rgba(212,175,55,0.26))",
          }}
          draggable={false}
        />
      </motion.div>
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
