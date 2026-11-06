import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import CelestialBackdrop from "@/components/CelestialBackdrop";
import Icon from "@/components/icons";
import { dateKey } from "@/lib/fortune/deterministic";

/**
 * 运势专区 —— /fortune
 *
 * ⚠️ 竞品对标：
 *   Tarot Run 的顶栏有「每日塔罗 / 塔罗百科」；
 *   Tarotap 有「年運 / 流年 / 四季 / 月運 / 每日運勢」五种。
 *   → 运势内容是**回访钩子 + SEO 流量入口**。
 *
 * ⚠️ 为什么这个页面是 server 组件：
 *   SEO —— 运势类查询有稳定搜索量，客户端渲染抓不到。
 */
export const metadata: Metadata = {
  title: "运势专区 · 每日塔罗 / 年运 / 流年 / 四季 · Mystic Tarot",
  description:
    "免费塔罗运势：每日之牌、月运、四季牌阵、年度主题与 12 个月流年运势。无需注册，即刻查看属于你的星象指引。",
  openGraph: {
    title: "运势专区 · Mystic Tarot",
    description: "每日之牌 · 月运 · 四季 · 年运与流年运势",
  },
};

/**
 * 动态部分（依赖当前日期 → 必须在 Suspense 内，PPR 硬约束）
 */
async function FortuneEntries() {
  // ⚠️ PPR：必须先 await connection()，否则 new Date() 会在预渲染期报错
  await connection();
  const today = new Date();
  const todayKey = dateKey(today);
  const year = today.getFullYear();
  const month = today.getMonth() + 1;

  const entries = [
    {
      href: `/daily/${todayKey}`,
      icon: "moon" as const,
      title: "每日之牌",
      desc: "今天与你有关的那张牌 · 每日更新",
      badge: "今日",
    },
    {
      href: `/fortune/monthly`,
      icon: "orbit" as const,
      title: "本月运势",
      desc: `${year} 年 ${month} 月 · 上旬 / 中旬 / 下旬`,
      badge: "免费",
    },
    {
      href: `/fortune/seasonal`,
      icon: "crystal" as const,
      title: "四季牌阵",
      desc: "一季五张牌 · 看清这段时间的走向",
      badge: "深度",
    },
    {
      href: `/fortune/yearly`,
      icon: "sparkle" as const,
      title: `${year} 年运与流年`,
      desc: "年度主题牌 + 12 个月逐月运势",
      badge: "全年",
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {entries.map((e) => (
        <Link
          key={e.href}
          href={e.href}
          className="group relative rounded-2xl border border-white/8 bg-purple-950/20 backdrop-blur-sm p-5 hover:border-purple-400/30 hover:bg-purple-900/20 transition-all"
        >
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-full border border-purple-400/25 bg-purple-500/10 flex items-center justify-center shrink-0 group-hover:border-purple-400/50 transition-colors">
              <Icon name={e.icon} size={17} className="text-purple-200/75" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-base text-purple-50 tracking-wider">{e.title}</h2>
                <span className="px-1.5 py-0.5 rounded text-[9px] border border-purple-400/25 text-purple-300/60">
                  {e.badge}
                </span>
              </div>
              <p className="text-xs text-purple-200/45 leading-relaxed">{e.desc}</p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function FortuneIndexPage() {
  return (
    <main className="min-h-[100dvh] relative overflow-hidden">
      <CelestialBackdrop tint="rgba(212, 175, 55, 0.16)" 
        image="/images/celestial/bg-fortune.webp"
        imagePosition="center center"
      />

      <div className="relative z-10 max-w-2xl mx-auto px-5 py-10 sm:py-16">
        <nav className="mb-10 text-sm">
          <Link href="/" className="text-purple-300/50 hover:text-purple-200 transition-colors">
            ← 回到占卜
          </Link>
        </nav>

        <header className="text-center mb-10">
          <p className="text-[11px] tracking-[0.35em] text-purple-300/40 mb-2">
            运 势 专 区
          </p>
          <h1 className="text-2xl sm:text-3xl tracking-[0.2em] text-purple-50 mb-3">
            星辰的周期与你的节奏
          </h1>
          <p className="text-sm text-purple-200/45 leading-relaxed">
            每日、月、季、年 —— 四个尺度，看清自己的处境。
          </p>
        </header>

        {/* ⚠️ Suspense 边界：new Date() 必须在里面 */}
        <Suspense fallback={<div className="h-64" />}>
          <FortuneEntries />
        </Suspense>

        {/* 说明 */}
        <p className="mt-10 text-[11px] leading-relaxed text-purple-300/25 text-center">
          运势内容基于传统牌义与确定性抽牌规则生成，仅供自我反思与参考，
          <br />
          不构成医疗、法律或财务建议。
        </p>
      </div>
    </main>
  );
}
