import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import CelestialBackdrop from "@/components/CelestialBackdrop";
import TarotCardFrame from "@/components/TarotCardFrame";
import CelestialPanel, { ArcaneTag } from "@/components/CelestialPanel";
import { buildSeasonContent } from "@/lib/fortune/server";
import { cardsOfTheSeason } from "@/lib/fortune/deterministic";

/**
 * 四季牌阵 —— /fortune/seasonal
 *
 * ⚠️ LLM 一次性生成 + 按季缓存（一年 4 次）→ 成本 ≈ ¥0.05/年。
 * ⚠️ PPR：`new Date()` 必须在 Suspense 边界内。
 */
export const metadata: Metadata = {
  title: "四季塔罗牌阵 · 季度运势 | Mystic Tarot",
  description:
    "免费塔罗四季牌阵：一季五张牌（起点、展开、阻碍、转机、落点），看清这段时间的走向与转机在哪。",
};

/** 动态部分 */
async function SeasonalContent() {
  // ⚠️ PPR：必须先 await connection()，否则 new Date() 会在预渲染期报错
  await connection();
  const now = new Date();
  const fortune = await buildSeasonContent(now);
  const items = cardsOfTheSeason(now);

  return (
    <>
      <header className="text-center mb-10">
        <p className="text-[11px] tracking-[0.35em] text-purple-300/40 mb-2">
          四 季 牌 阵 · SEASONAL
        </p>
        <h1 className="text-2xl sm:text-3xl tracking-[0.2em] text-purple-50 mb-3">
          {fortune.year} 年 · {fortune.season}季
        </h1>
        <p className="text-sm text-purple-200/45">起点 · 展开 · 阻碍 · 转机 · 落点</p>
      </header>

      {/* ---------- 四季五张（2026-11-05：改成「弧形牌阵 + 解读列表」两段式） ----------
          ⚠️ 为什么弧形而不是竖排：
            竖排五张 = 一个列表，读起来像"目录"；
            弧形（两端低、中间高）= 一副**摊开的牌阵**，
            且弧度与魔法阵呼应 → 页面有统一的视觉语言。 */}
      <div className="mb-10">
        {/* 弧形牌阵 */}
        <div className="relative flex justify-center items-end gap-3 sm:gap-6 mb-10 px-2">
          {fortune.segments.map((s, i) => {
            const item = items[i];
            if (!item) return null;
            // 弧形：中间高、两端低
            const lift = [26, 8, 0, 8, 26][i] ?? 0;
            return (
              <div
                key={s.pos}
                className="relative z-10 flex flex-col items-center"
                style={{ transform: `translateY(${lift}px)` }}
              >
                <p className="text-[10px] tracking-[0.2em] text-emerald-200/60 mb-2">
                  {s.pos}
                </p>
                <TarotCardFrame
                  src={item.card.image}
                  alt={`${s.nameZh}${s.reversed ? "（逆位）" : ""}`}
                  reversed={item.reversed}
                  tone="gold"
                  width={112}
                />
                <p
                  className="text-[13px] text-purple-50/85 tracking-wider mt-2"
                  style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                >
                  {s.nameZh}
                </p>
              </div>
            );
          })}
        </div>

        {/* 解读列表 */}
        <div className="space-y-3">
          {fortune.segments.map((s, i) => {
            const item = items[i];
            if (!item) return null;
            return (
              <CelestialPanel key={`t${s.pos}`} tone="gold" padding="p-4">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded text-[10px] border border-emerald-400/30 text-emerald-200/70">
                    {s.pos}
                  </span>
                  <span className="text-[13px] text-purple-50/90 tracking-wider">{s.nameZh}</span>
                  {s.reversed && <span className="text-[10px] text-cyan-200/50">逆位</span>}
                  {s.keywords.length > 0 && (
                    <span className="flex flex-wrap gap-1.5">
                      {s.keywords.map((k) => (
                        <ArcaneTag key={k}>{k}</ArcaneTag>
                      ))}
                    </span>
                  )}
                </div>
                <p className="text-[13px] leading-[1.9] text-purple-100/72 whitespace-pre-line">
                  {s.text}
                </p>
              </CelestialPanel>
            );
          })}
        </div>
      </div>
    </>
  );
}

export default function SeasonalPage() {
  return (
    <main className="min-h-[100dvh] relative overflow-hidden">
      {/* ⚠️ 2026-11-05 视觉重设计：统一的深空背景（四季偏青绿） */}
      <CelestialBackdrop tint="rgba(16, 185, 129, 0.13)" 
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

        {/* ⚠️ Suspense 边界：new Date() + LLM 调用都在里面 */}
        <Suspense
          fallback={
            <div className="text-center py-16 text-purple-300/30 text-sm">正在推算本季牌阵…</div>
          }
        >
          <SeasonalContent />
        </Suspense>

        <p className="mt-10 text-[11px] leading-relaxed text-purple-300/25 text-center">
          运势内容基于传统牌义生成，仅供自我反思与参考，
          <br />
          不构成医疗、法律或财务建议。
        </p>
      </div>
    </main>
  );
}
