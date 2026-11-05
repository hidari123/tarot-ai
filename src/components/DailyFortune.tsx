"use client";

import Link from "next/link";
import { useMemo } from "react";
import Icon from "@/components/icons";
import { buildDailyContent } from "@/lib/fortune/build";
import CelestialBackdrop from "@/components/CelestialBackdrop";
import TarotCardFrame from "@/components/TarotCardFrame";
import CelestialPanel, { ArcaneTag } from "@/components/CelestialPanel";

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
        <section className="flex flex-col sm:flex-row gap-8 items-center sm:items-start mb-10">
          {/* 牌面（2026-11-05：改用 TarotCardFrame —— 金框 + 悬停 3D + 逆位标记） */}
          <div className="shrink-0">
            <TarotCardFrame
              src={daily.card.image}
              alt={`${daily.card.nameZh}${daily.reversed ? "（逆位）" : ""}`}
              reversed={daily.reversed}
              tone="gold"
              width={210}
              label={daily.card.nameZh}
            />
          </div>

          {/* 文案 */}
          <div className="flex-1">
            <CelestialPanel tone="gold" padding="p-6">
              {/* 关键词（铜牌样式） */}
              {dailySeg.keywords.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {dailySeg.keywords.map((k) => (
                    <ArcaneTag key={k} tone="gold">
                      {k}
                    </ArcaneTag>
                  ))}
                </div>
              )}
              {/* 正文 */}
              <div className="text-[15px] leading-[2] text-purple-100/85 whitespace-pre-line">
                {dailySeg.text}
              </div>
            </CelestialPanel>

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

        {/* 本周七牌（2026-11-05：从方块网格改成**围成一圈**）
            ⚠️ 为什么围圆：
              一行七张牌是"列表"，看不出"一周"是一个整体；
              围成圆（像星盘）→ 视觉上就是一个**周期**，
              而且和魔法阵的圆形成呼应。
            ⚠️ 桌面端用 SVG 绝对定位围圆；移动端退回横向可滚动（圆在窄屏放不下）。 */}
        <section className="mb-12">
          <h2 className="text-[11px] tracking-[0.3em] text-purple-300/40 mb-6 text-center">
            本 周 七 牌
          </h2>

          {/* 桌面端：围成圆 */}
          <div className="hidden sm:block relative mx-auto" style={{ width: 560, height: 560 }}>
            {/* 圆环连线 */}
            <svg
              viewBox="0 0 560 560"
              className="absolute inset-0 pointer-events-none"
              style={{ opacity: 0.5 }}
            >
              <circle
                cx="280"
                cy="280"
                r="196"
                fill="none"
                stroke="rgba(168,85,247,0.22)"
                strokeWidth="1"
                strokeDasharray="4 7"
              />
              <circle
                cx="280"
                cy="280"
                r="150"
                fill="none"
                stroke="rgba(212,175,55,0.14)"
                strokeWidth="1"
              />
            </svg>

            {weekSegs.map((s, i) => {
              // 起始角度 -90°（正上方），顺时针均分
              const angle = (i * (360 / 7) - 90) * (Math.PI / 180);
              const r = 196;
              const x = 280 + r * Math.cos(angle);
              const y = 280 + r * Math.sin(angle);
              return (
                <div
                  key={i}
                  className="absolute group/week -translate-x-1/2 -translate-y-1/2"
                  style={{ left: x, top: y, width: 104 }}
                >
                  <TarotCardFrame
                    src={s.image}
                    alt={s.nameZh}
                    reversed={s.reversed}
                    tone="dim"
                    width={104}
                    interactive={false}
                  />
                  {/* 牌名 + 短提示 */}
                  <div className="mt-1.5 text-center">
                    <p className="text-[10px] tracking-wider text-purple-200/60">
                      {["周一", "周二", "周三", "周四", "周五", "周六", "周日"][i]}
                    </p>
                    <p className="text-[10px] text-purple-300/45 mt-0.5 leading-tight line-clamp-2">
                      {s.nameZh} · {s.keywords[0] ?? "留意直觉"}
                    </p>
                  </div>
                </div>
              );
            })}

            {/* 圆心的说明 */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[190px] text-center">
              <p className="text-[11px] tracking-[0.2em] text-purple-300/35">一周的节奏</p>
              <p className="text-[12px] text-purple-100/55 mt-2 leading-relaxed">
                七张牌绕成一周，
                <br />
                每天走到哪一张，
                <br />
                就是当天的指引。
              </p>
            </div>
          </div>

          {/* 移动端：横向滚动 */}
          <div className="sm:hidden flex gap-3 overflow-x-auto pb-3 -mx-5 px-5">
            {weekSegs.map((s, i) => (
              <div key={i} className="shrink-0 w-[112px]">
                <TarotCardFrame
                  src={s.image}
                  alt={s.nameZh}
                  reversed={s.reversed}
                  tone="dim"
                  width={112}
                  interactive={false}
                />
                <p className="text-center text-[10px] text-purple-200/60 mt-1.5">
                  {["周一", "周二", "周三", "周四", "周五", "周六", "周日"][i]}
                </p>
                <p className="text-center text-[10px] text-purple-300/45">{s.nameZh}</p>
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
