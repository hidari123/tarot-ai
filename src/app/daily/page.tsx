import { redirect } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";
import { dateKey } from "@/lib/fortune/deterministic";

/**
 * /daily → 重定向到今天的每日之牌
 *
 * ⚠️ 为什么要有这个中转页（而不是在首页直接拼 /daily/2026-11-04）：
 *   首页是 **client 组件**，而在 client 组件里写 `new Date()` 会被 PPR 拒绝：
 *   "Next.js encountered the unstable value `new Date()` in a Client Component"
 *   （client 组件在预渲染期同样会被求值）。
 *   → 让这个中转页（server 组件）算日期，客户端完全不需要碰时间。
 *
 * ⚠️ 为什么要用 redirect 而不是页面内软跳转：
 *   redirect 是**服务端 308** → 搜索引擎看到的是具体日期的 URL（SEO 友好），
 *   且 URL 永远指向"那一天的牌"（可分享、可收藏）。
 *
 * ⚠️⚠️ PPR 的两道坎（实测踩到）：
 *   ① `new Date()` 必须先 `await connection()` → 否则报 "unstable value"
 *   ② `redirect()` 也属于 runtime data → 必须放在 **Suspense 边界内**
 *      （边界外的 redirect 会在预渲染期直接抛错）
 */
async function RedirectToToday(): Promise<never> {
  await connection();
  redirect(`/daily/${dateKey(new Date())}`);
}

export default function DailyIndexPage() {
  return (
    <Suspense fallback={<div className="min-h-[100dvh]" />}>
      <RedirectToToday />
    </Suspense>
  );
}
