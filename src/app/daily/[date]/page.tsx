import type { Metadata } from "next";
import { Suspense } from "react";
import DailyFortune from "@/components/DailyFortune";
import { cardOfTheDay, dateKey, parseDateKey } from "@/lib/fortune/deterministic";

/**
 * 每日之牌页面 —— /daily/2026-11-04
 *
 * ⚠️⚠️ SEO 是这个页面存在的**主要理由**（除了回访钩子）：
 *   我们的首页是**纯客户端 SPA** → 搜索引擎抓不到内容。
 *   而「今日塔罗牌」这类查询有**稳定搜索量** —— 它是运势类站点的流量顶。
 *   → 所以必须有**服务端渲染 + generateMetadata** 的独立页面。
 *
 * ⚠️ Next 16 + cacheComponents 的规则（查过官方文档）：
 *   · `generateStaticParams` **必须返回至少一个 param**（空数组会 build 报错）
 *   · 走 `generateStaticParams` 的路由：params 要 await 在 **Suspense 边界内**
 *     （我们开了 partialPrefetching，正好是这个场景）
 *   · 不能用 `dynamicParams = false` —— 否则未预生成的日期直接 404
 *     （我们希望"任意日期都能看"）
 */

/** 预生成的范围：过去 7 天 + 未来 30 天 */
const PAST_DAYS = 7;
const FUTURE_DAYS = 30;

function dateKeysForPrerender(): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = -PAST_DAYS; i <= FUTURE_DAYS; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, 12);
    out.push(dateKey(d));
  }
  return out;
}

/**
 * 预生成参数
 *
 * ⚠️ 用 `dynamic = "force-static"` + 空数组会报错 → 必须返回至少一个。
 *   这里返回 38 个（过去 7 天 + 未来 30 天）—— 覆盖回访与近期。
 */
export function generateStaticParams(): Array<{ date: string }> {
  return dateKeysForPrerender().map((date) => ({ date }));
}

/**
 * 页面元数据（SEO 关键）
 *
 * ⚠️ 没有 generateMetadata 的静态页 = 搜索引擎只看到一个空壳。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ date: string }>;
}): Promise<Metadata> {
  const { date } = await params;
  const d = parseDateKey(date);
  if (!d) return { title: "每日之牌 · Mystic Tarot" };
  const { card, reversed } = cardOfTheDay(d);
  const title = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 今日之牌「${card.nameZh}」`;
  const description = `今日塔罗牌是「${card.nameZh}」${reversed ? "（逆位）" : ""}：${card.upright.slice(0, 40)}… 免费查看你的今日塔罗牌与本周运势。`;
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    // ⚠️ 让搜索引擎知道这是"每日更新"的内容
    other: { "article:published_time": d.toISOString() },
  };
}

export default async function DailyPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  return (
    /**
     * ⚠️ Suspense 边界必须包住 params 的 await ——
     *   否则未预生成的日期无法在运行时渲染（Next 16 官方要求）。
     */
    <Suspense fallback={<div className="min-h-[100dvh]" />}>
      <DailyFortune dateParam={await params.then((p) => p.date)} />
    </Suspense>
  );
}
