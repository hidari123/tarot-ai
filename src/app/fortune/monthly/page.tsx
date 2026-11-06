import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import CelestialBackdrop from "@/components/CelestialBackdrop";
import TarotCardFrame from "@/components/TarotCardFrame";
import CelestialPanel, { ArcaneTag } from "@/components/CelestialPanel";
import { buildMonthlyContent } from "@/lib/fortune/build";

/**
 * 月运 —— /fortune/monthly
 *
 * ⚠️ 零 LLM 成本（拼装）：月运每月更新一次，量可控 → 不必付费生成。
 *
 * ⚠️⚠️ PPR 的硬约束（实测踩到）：
 *   `new Date()` 在**静态预渲染期**是"不稳定值" → Next 会直接报错：
 *   "Next.js encountered the unstable value `new Date()` while prerendering"。
 *   → 解法：把依赖当前时间的部分放进 **Suspense 边界**内 ——
 *     静态壳（标题/说明）先出，动态内容在边界内流式补上。
 */
export const metadata: Metadata = {
  title: "本月运势 · 塔罗月运 | Mystic Tarot",
  description:
    "免费塔罗月运：上旬、中旬、下旬三张牌，看清这个月的节奏与重点。无需注册，即刻查看。",
};

/** 动态部分（依赖当前日期 → 必须在 Suspense 内，PPR 硬约束） */
async function MonthlyContent() {
  /**
   * ⚠️⚠️ PPR 的正确解法（Next 16 官方）：
   *   `await connection()` 让渲染**等待真实请求**，从而把后续代码排除出静态壳。
   *   光包 Suspense 边界**不够** —— 边界内的静态部分仍会在预渲染期被求值，
   *   于是 `new Date()` 依然触发 "unstable value" 构建错误。
   */
  await connection();
  const now = new Date();
  const { items, segments, label } = buildMonthlyContent(now);

  return (
    <>
      <header className="text-center mb-10">
        <p className="text-[11px] tracking-[0.35em] text-purple-300/40 mb-2">
          月 运 · MONTHLY
        </p>
        <h1 className="text-2xl sm:text-3xl tracking-[0.2em] text-purple-50 mb-3">{label}</h1>
        <p className="text-sm text-purple-200/45">三段时光，各有各的张力</p>
      </header>

      {/* ---------- 月运三张（2026-11-05：改成「牌阵 + 文案卡」两段式） ----------
          ⚠️ 为什么不用三列网格：
            三列网格看起来像"三个商品卡片"，而月运是**一段时间的三个段落**
            （上旬/中旬/下旬）—— 它们是**连续的**，不是并列的。
          ⚠️ 新布局：上面是牌阵（横向排开 + 连线），下面是各自的解读。
            → 牌阵本身成为视觉主体，文案退居其次。 */}
      <div className="mb-10">
        {/* 牌阵 */}
        <div className="relative flex justify-center items-end gap-6 sm:gap-12 mb-8 px-4">
          {/* 连线（牌与牌之间） */}
          <svg
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            className="absolute inset-x-16 top-1/2 h-px pointer-events-none"
            style={{ opacity: 0.55 }}
          >
            <line x1="0" y1="5" x2="100" y2="5" stroke="rgba(212,175,55,0.35)" strokeWidth="0.4" strokeDasharray="1.5 1.5" vectorEffect="non-scaling-stroke" />
          </svg>

          {segments.map((s, i) => {
            const item = items[i];
            return (
              <div key={s.pos ?? i} className="relative z-10 flex flex-col items-center">
                <p className="text-[10px] tracking-[0.25em] text-amber-200/60 mb-2">
                  {s.pos}
                </p>
                <TarotCardFrame
                  src={item.card.image}
                  alt={`${item.card.nameZh}${item.reversed ? "（逆位）" : ""}`}
                  reversed={item.reversed}
                  tone="gold"
                  width={128}
                />
                <p
                  className="text-[15px] text-purple-50/90 tracking-widest mt-2"
                  style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                >
                  {s.nameZh}
                </p>
              </div>
            );
          })}
        </div>

        {/* 解读卡 */}
        <div className="grid gap-4 sm:grid-cols-3">
          {segments.map((s, i) => (
            <CelestialPanel key={`t${i}`} tone="gold" padding="p-5">
              <div className="flex flex-wrap gap-1.5 mb-3">
                {s.keywords.map((k) => (
                  <ArcaneTag key={k} tone="gold">
                    {k}
                  </ArcaneTag>
                ))}
              </div>
              <p className="text-[13px] leading-[1.95] text-purple-100/75 whitespace-pre-line">
                {s.text}
              </p>
            </CelestialPanel>
          ))}
        </div>
      </div>
    </>
  );
}

export default function MonthlyPage() {
  return (
    <main className="min-h-[100dvh] relative overflow-hidden">
      <CelestialBackdrop tint="rgba(212, 175, 55, 0.16)" 
        image="/images/celestial/bg-fortune.webp"
        imagePosition="center center"
      />

      <div className="relative z-10 max-w-3xl mx-auto px-5 py-10 sm:py-16">
        <nav className="mb-10 flex items-center justify-between text-sm">
          <Link href="/fortune" className="text-purple-300/50 hover:text-purple-200 transition-colors">
            ← 运势专区
          </Link>
          <Link href="/" className="text-purple-300/50 hover:text-purple-200 transition-colors">
            去占卜 →
          </Link>
        </nav>

        {/* ⚠️ Suspense 边界：new Date() 必须在里面 */}
        <Suspense
          fallback={
            <div className="text-center py-16 text-purple-300/30 text-sm">正在推算本月运势…</div>
          }
        >
          <MonthlyContent />
        </Suspense>

        <p className="mt-10 text-[11px] leading-relaxed text-purple-300/25 text-center">
          运势内容基于传统牌义与确定性抽牌规则生成，仅供自我反思与参考。
        </p>
      </div>
    </main>
  );
}
