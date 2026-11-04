import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
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

      {/* 五张牌 */}
      <div className="space-y-4 mb-10">
        {fortune.segments.map((s, i) => {
          const item = items[i];
          if (!item) return null;
          return (
            <section
              key={s.pos}
              className="flex gap-4 rounded-2xl border border-white/8 bg-purple-950/20 backdrop-blur-sm p-4 hover:border-emerald-400/20 transition-colors"
            >
              <div className="shrink-0 w-[84px] sm:w-[100px]">
                <div
                  className="rounded-lg overflow-hidden border border-emerald-400/20"
                  style={{ aspectRatio: "2 / 3" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.card.image}
                    alt={`${s.nameZh}${s.reversed ? "（逆位）" : ""}`}
                    className={`w-full h-full object-cover ${s.reversed ? "rotate-180" : ""}`}
                  />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded text-[10px] border border-emerald-400/30 text-emerald-200/70">
                    {s.pos}
                  </span>
                  <span className="text-sm text-purple-50/90 tracking-wider">{s.nameZh}</span>
                  {s.reversed && <span className="text-[10px] text-purple-300/40">逆位</span>}
                </div>
                {s.keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {s.keywords.map((k) => (
                      <span
                        key={k}
                        className="px-2 py-0.5 rounded-full border border-emerald-400/20 bg-emerald-500/10 text-[10px] text-emerald-200/70"
                      >
                        {k}
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-[13px] leading-[1.85] text-purple-100/65 whitespace-pre-line">
                  {s.text}
                </p>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

export default function SeasonalPage() {
  return (
    <main className="min-h-[100dvh] relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "radial-gradient(ellipse at 50% 15%, rgba(16,185,129,0.12), transparent 55%)",
        }}
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
