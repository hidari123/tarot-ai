"use client";

import Link from "next/link";
import { useMemo } from "react";
import Icon from "@/components/icons";
import { buildDailyContent } from "@/lib/fortune/build";
import CelestialBackdrop from "@/components/CelestialBackdrop";

/**
 * 每日之牌 —— 内容展示
 *
 * ⚠️ 为什么是 client 组件：
 *   页面本身是 server 组件（SEO 关键），但交互（分享、跳转）需要客户端。
 *   ⚠️ 更实际的理由：我们要复用项目的星空背景与动效（都是 client 组件）。
 */
export default function DailyFortune({ dateParam }: { dateParam: string }) {
  const content = useMemo(() => buildDailyContent(dateParam), [dateParam]);

  if (!content) {
    return (
      <main className="min-h-[100dvh] flex items-center justify-center px-6">
        <div className="text-center">
          <p className="text-purple-200/60 mb-4">这一天不存在于星历之上</p>
          <Link href="/fortune" className="text-purple-300/80 underline text-sm">
            回到运势专区
          </Link>
        </div>
      </main>
    );
  }

  const { d, daily, dailySeg, weekSegs } = content;
  const dateText = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];

  return (
    <main className="min-h-[100dvh] relative overflow-hidden">
      {/* ⚠️ 2026-11-05 视觉重设计：统一的深空背景
          （运势页用**金色**主光源 —— 牌与运势是"金色的"，占卜页是"紫色的"） */}
      <CelestialBackdrop tint="rgba(212, 175, 55, 0.16)" />

      <div className="relative z-10 max-w-3xl mx-auto px-5 py-10 sm:py-16">
        {/* 顶部导航 */}
        <nav className="flex items-center justify-between mb-8 text-sm">
          <Link href="/" className="text-purple-300/50 hover:text-purple-200 transition-colors">
            ← 回到占卜
          </Link>
          <Link href="/fortune" className="text-purple-300/50 hover:text-purple-200 transition-colors">
            运势专区 →
          </Link>
        </nav>

        {/* 日期 */}
        <header className="text-center mb-8">
          <p className="text-[11px] tracking-[0.35em] text-purple-300/40 mb-2">
            今日之牌 · DAILY CARD
          </p>
          <h1 className="text-2xl sm:text-3xl tracking-[0.2em] text-purple-50">
            {dateText}
          </h1>
          <p className="text-xs text-purple-300/35 mt-2">{weekday}</p>
        </header>

        {/* 主牌 */}
        <section className="flex flex-col sm:flex-row gap-6 items-center sm:items-start mb-10">
          {/* 牌面 */}
          <div className="shrink-0 w-[180px] sm:w-[220px]">
            <div
              className="relative rounded-2xl overflow-hidden border border-purple-400/40 shadow-[0_0_50px_rgba(139,92,246,0.28)]"
              style={{ aspectRatio: "2 / 3" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={daily.card.image}
                alt={`${daily.card.nameZh}${daily.reversed ? "（逆位）" : ""}`}
                className={`w-full h-full object-cover ${daily.reversed ? "rotate-180" : ""}`}
              />
              {daily.reversed && (
                <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-purple-950/80 border border-purple-400/40 text-[10px] text-purple-200">
                  逆位
                </div>
              )}
            </div>
            <p
              className="text-center mt-3 text-lg text-purple-50 tracking-widest"
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              {daily.card.nameZh}
            </p>
          </div>

          {/* 文案 */}
          <div className="flex-1">
            <div className="rounded-2xl border border-white/10 bg-purple-950/20 backdrop-blur-sm p-5">
              {/* 关键词 */}
              {dailySeg.keywords.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {dailySeg.keywords.map((k) => (
                    <span
                      key={k}
                      className="px-2.5 py-0.5 rounded-full border border-purple-400/30 bg-purple-500/10 text-[11px] text-purple-200/80"
                    >
                      {k}
                    </span>
                  ))}
                </div>
              )}
              {/* 正文 */}
              <div className="text-sm sm:text-[15px] leading-[1.9] text-purple-100/80 whitespace-pre-line">
                {dailySeg.text}
              </div>
            </div>

            {/* 典籍牌意 */}
            <details className="mt-3 group">
              <summary className="cursor-pointer text-[11px] text-purple-300/40 hover:text-purple-200/70 transition-colors select-none">
                查看典籍牌意与牌面故事
              </summary>
              <div className="mt-3 rounded-xl border border-white/5 bg-black/20 p-4 space-y-3">
                <div>
                  <p className="text-[10px] tracking-[0.2em] text-purple-300/35 mb-1.5">
                    典籍所载（{daily.reversed ? "逆位" : "正位"}）
                  </p>
                  <p className="text-[13px] leading-relaxed text-purple-100/65">
                    {dailySeg.meaning}
                  </p>
                </div>
                {dailySeg.narrative && (
                  <div>
                    <p className="text-[10px] tracking-[0.2em] text-purple-300/35 mb-1.5">
                      牌面故事
                    </p>
                    <p className="text-[13px] leading-relaxed text-purple-200/45">
                      {dailySeg.narrative}
                    </p>
                  </div>
                )}
              </div>
            </details>
          </div>
        </section>

        {/* 本周七牌 */}
        <section className="mb-10">
          <h2 className="text-[11px] tracking-[0.3em] text-purple-300/40 mb-4 text-center">
            本 周 七 牌
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {weekSegs.map((s, i) => (
              <div
                key={i}
                className="rounded-xl border border-white/8 bg-purple-950/15 p-3 hover:border-purple-400/25 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-purple-300/40">
                    {["周一", "周二", "周三", "周四", "周五", "周六", "周日"][i]}
                  </span>
                  <span className="text-[10px] text-purple-200/50">{s.nameZh}</span>
                </div>
                <p className="text-[11px] leading-relaxed text-purple-100/55 line-clamp-3">
                  {s.text}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* 行动召唤 */}
        <section className="rounded-2xl border border-purple-400/20 bg-gradient-to-br from-purple-900/25 to-transparent p-6 text-center">
          <Icon name="sparkle" size={22} className="text-purple-200/70 mx-auto mb-3" />
          <p className="text-sm text-purple-100/70 mb-4">
            想知道这张牌对你意味着什么？
            <br />
            占卜师会结合你的处境，给出属于你的解读。
          </p>
          <Link
            href="/"
            className="inline-block px-6 py-2.5 rounded-full bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm tracking-[0.15em] shadow-[0_0_24px_rgba(139,92,246,0.4)] hover:shadow-[0_0_34px_rgba(139,92,246,0.6)] transition-shadow"
          >
            开始一次占卜
          </Link>
        </section>
      </div>
    </main>
  );
}
