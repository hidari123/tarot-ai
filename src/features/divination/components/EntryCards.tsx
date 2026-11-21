"use client";

import Link from "next/link";
import { motion } from "framer-motion";

/**
 * EntryCards —— 首页的三个入口（2026-11-19 移到**页面左上角**）
 *
 * ⚠️⚠️ 用户要求（原文）：
 *   「今日运势这些可以放在页面左上角」
 *   「第一页不展示对话框 只展示今日运势这些和8张卡片」
 *
 * ⚠️⚠️ 为什么从「副标题下方」改成「左上角固定」：
 *   · 原来三张大卡片横排在副标题下 → **占掉一整屏**（y=450~520）
 *   · 现在首页的主内容是「水晶球弧线 + 8 张写实卡片」→ 入口卡不该占这个位置
 *   · 竞品（Tarot Run / Tarotap）都把「每日运势」做成**顶栏入口**
 *   → 移到左上角，**竖排紧凑**，不再抢主流程的视觉 ✅
 *
 * ⚠️ 保留的对比度修正（2026-11-06 踩坑）：
 *   背景紫 / 容器深 / 描边金 / 图标金 / 文字白
 */

/** 三个入口（数据与渲染分离 → 以后加第四个入口只改这里） */
const ENTRIES = [
  {
    href: "/daily",
    img: "/images/celestial/icon-daily.webp",
    title: "今日之牌",
    desc: "今天与你有关的那张牌",
  },
  {
    href: "/fortune",
    img: "/images/celestial/icon-fortune.webp",
    title: "运势专区",
    desc: "每日 · 月 · 季 · 年运",
  },
  {
    href: "/oracle",
    img: "/images/celestial/icon-oracle.webp",
    title: "问神谕",
    desc: "不必抽牌，也能问",
  },
] as const;

export default function EntryCards() {
  return (
    <motion.nav
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.3, duration: 0.6 }}
      className="fixed left-4 top-4 z-30 flex flex-col gap-1.5"
      aria-label="运势入口"
    >
      {ENTRIES.map((e) => (
        <Link
          key={e.href}
          href={e.href}
          className="group relative flex items-center gap-2 rounded-xl border border-[rgba(212,175,55,0.24)] bg-[rgba(9,5,20,0.72)] backdrop-blur-md px-2.5 py-1.5 transition-all duration-300 hover:border-[rgba(240,217,138,0.55)] hover:bg-[rgba(20,10,42,0.85)]"
          style={{
            boxShadow:
              "0 6px 22px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
          }}
        >
          {/* 悬停时的金色边光 */}
          <span
            className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
            style={{
              boxShadow:
                "0 0 22px rgba(212,175,55,0.3), inset 0 0 14px rgba(212,175,55,0.08)",
            }}
          />
          {/* 图标（金色 AI 纹样，无底圈） */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={e.img}
            alt=""
            className="h-[22px] w-[22px] shrink-0 object-contain transition-transform duration-300 group-hover:scale-110"
            style={{
              filter:
                "drop-shadow(0 0 5px rgba(240,217,138,0.6)) drop-shadow(0 0 12px rgba(212,175,55,0.28))",
            }}
          />
          <span className="min-w-0 leading-tight">
            <span className="block text-[12px] tracking-[0.1em] text-[rgba(255,248,235,0.94)] group-hover:text-amber-50">
              {e.title}
            </span>
            {/**
             * ⚠️ 描述只在**桌面端**显示（`hidden md:block`）
             * ⚠️ 为什么：移动端左上角只有 420px 宽 → 竖排三张卡会**压住标题**
             *   （实测 MOIRA 被挡）→ 移动端只留图标 + 标题 ✅
             */}
            <span className="hidden text-[9px] text-[rgba(203,190,255,0.6)] md:block">
              {e.desc}
            </span>
          </span>
        </Link>
      ))}
    </motion.nav>
  );
}
