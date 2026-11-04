import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
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

      <div className="grid gap-4 sm:grid-cols-3">
        {segments.map((s, i) => {
          const item = items[i];
          return (
            <section
              key={s.pos ?? i}
              className="rounded-2xl border border-white/8 bg-purple-950/20 backdrop-blur-sm overflow-hidden"
            >
              {/* 牌面 */}
              <div className="relative" style={{ aspectRatio: "3 / 4" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.card.image}
                  alt={`${item.card.nameZh}${item.reversed ? "（逆位）" : ""}`}
                  className={`w-full h-full object-cover ${item.reversed ? "rotate-180" : ""}`}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#0d0a18] via-transparent to-transparent" />
                <div className="absolute bottom-3 left-0 right-0 text-center">
                  <p className="text-[10px] tracking-[0.25em] text-purple-200/60 mb-1">{s.pos}</p>
                  <p
                    className="text-lg text-purple-50 tracking-widest"
                    style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                  >
                    {s.nameZh}
                  </p>
                </div>
              </div>
              {/* 文案 */}
              <div className="p-4">
                <div className="flex flex-wrap gap-1.5 mb-2.5">
                  {s.keywords.map((k) => (
                    <span
                      key={k}
                      className="px-2 py-0.5 rounded-full border border-purple-400/25 bg-purple-500/10 text-[10px] text-purple-200/75"
                    >
                      {k}
                    </span>
                  ))}
                </div>
                <p className="text-[13px] leading-[1.85] text-purple-100/70 whitespace-pre-line">
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

export default function MonthlyPage() {
  return (
    <main className="min-h-[100dvh] relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 50% 20%, rgba(124,58,237,0.15), transparent 55%)",
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
