import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import CelestialBackdrop from "@/components/CelestialBackdrop";
import { buildYearContent } from "@/lib/fortune/server";
import { cardsOfTheYear } from "@/lib/fortune/deterministic";

/**
 * 年运与流年 —— /fortune/yearly
 *
 * ⚠️⚠️ 这个页面是**唯一**会调用 LLM 的运势页面（但只调一次/年）：
 *   年运 + 12 个月流年 → 一次性生成 → 缓存进 fortune_cache → 全年零成本。
 *
 * ⚠️ 为什么值得付费：
 *   · 用户停留最久的页面（看一整年）
 *   · 一年只有一次更新（成本 ≈ ¥0.2/年）
 *   · 质量直接影响"这个站值不值得信"的印象
 *
 * ⚠️ 降级：LLM 不可用 → 拼装版本（compose.ts）→ 功能不挂。
 *
 * ⚠️ PPR：`new Date()` 必须在 Suspense 边界内（否则预渲染期报 unstable value）。
 */
export const metadata: Metadata = {
  title: "年度塔罗运势 · 年运与流年 | Mystic Tarot",
  description:
    "免费塔罗年运：年度主题牌 + 12 个月逐月流年运势，看清这一年的主线与每个月的节奏。",
};

/** 动态部分 */
async function YearlyContent() {
  // ⚠️ PPR：必须先 await connection()，否则 new Date() 会在预渲染期报错
  await connection();
  const year = new Date().getFullYear();
  const fortune = await buildYearContent(year);
  const { theme } = cardsOfTheYear(year);

  return (
    <>
      <header className="text-center mb-10">
        <p className="text-[11px] tracking-[0.35em] text-purple-300/40 mb-2">
          年 运 与 流 年 · YEARLY
        </p>
        <h1 className="text-2xl sm:text-3xl tracking-[0.2em] text-purple-50 mb-3">
          {year} 年的星象主线
        </h1>
        <p className="text-sm text-purple-200/45">
          主题牌「{fortune.themeNameZh}」{fortune.themeReversed ? "（逆位）" : ""}
        </p>
      </header>

      {/* 主题牌 */}
      <section className="flex flex-col sm:flex-row gap-6 items-center sm:items-start mb-12">
        <div className="shrink-0 w-[160px] sm:w-[190px]">
          <div
            className="relative rounded-2xl overflow-hidden border border-amber-400/30 shadow-[0_0_45px_rgba(217,119,6,0.22)]"
            style={{ aspectRatio: "2 / 3" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={theme.card.image}
              alt={`${theme.card.nameZh}${theme.reversed ? "（逆位）" : ""}`}
              className={`w-full h-full object-cover ${theme.reversed ? "rotate-180" : ""}`}
            />
          </div>
          <p
            className="text-center mt-3 text-lg text-amber-100/90 tracking-widest"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            {theme.card.nameZh}
          </p>
          <p className="text-center text-[10px] text-amber-300/45 mt-0.5">年度主题牌</p>
        </div>

        <div className="flex-1">
          <div className="rounded-2xl border border-amber-400/15 bg-amber-900/10 backdrop-blur-sm p-5">
            {fortune.themeKeywords.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-4">
                {fortune.themeKeywords.map((k) => (
                  <span
                    key={k}
                    className="px-2.5 py-0.5 rounded-full border border-amber-400/30 bg-amber-500/10 text-[11px] text-amber-200/80"
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}
            <div className="text-sm sm:text-[15px] leading-[1.9] text-amber-50/80 whitespace-pre-line">
              {fortune.themeText}
            </div>
          </div>
        </div>
      </section>

      {/* 12 个月 */}
      <section className="mb-10">
        <h2 className="text-[11px] tracking-[0.3em] text-purple-300/40 mb-5 text-center">
          十 二 个 月 · 流 年
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {fortune.months.map((m) => (
            <article
              key={m.month}
              className="rounded-xl border border-white/8 bg-purple-950/15 p-4 hover:border-purple-400/25 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] tracking-[0.2em] text-purple-200/60">{m.month} 月</span>
                <span className="text-[11px] text-purple-300/45">
                  {m.nameZh}
                  {m.reversed ? "（逆）" : ""}
                </span>
              </div>
              <p className="text-[13px] leading-[1.85] text-purple-100/65 whitespace-pre-line">
                {m.text}
              </p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

export default function YearlyPage() {
  return (
    <main className="min-h-[100dvh] relative overflow-hidden">
      <CelestialBackdrop tint="rgba(212, 175, 55, 0.16)" />

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
          /**
           * ⚠️ fallback 里**不能**用 new Date()（实测踩到）：
           *   fallback 在预渲染期就会被求值 → 同样触发 "unstable value" 构建错误。
           *   → fallback 只写静态文案。
           */
          fallback={
            <div className="text-center py-16 text-purple-300/30 text-sm">
              正在推算今年的星象主线…
            </div>
          }
        >
          <YearlyContent />
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
