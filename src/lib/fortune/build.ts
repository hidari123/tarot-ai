/**
 * 运势内容的组装入口 —— **纯函数层**（无 DB、无 LLM）
 *
 * ⚠️⚠️ 为什么必须与 fortune-cache.ts 严格分开：
 *   `fortune-cache.ts` 依赖 db.ts（better-sqlite3 原生模块）与 LLM 调用 ——
 *   **客户端组件绝不能间接引用它**（Next 打包原生模块会失败：
 *   "Module not found: better_sqlite3.node"）。
 *   → 本文件只放**纯计算**（确定性选牌 + 文案拼装），两端都能安全引用。
 *   → 需要 LLM/DB 的函数在 `server.ts`（server-only）。
 *
 * ⚠️ 页面（server 组件，负责 SEO）与展示组件（client 组件）共用同一套组装逻辑 ——
 *   放在 lib 下避免逻辑漂移，同时不会把 server-only 拖进客户端 bundle。
 */

import {
  cardOfTheDay,
  cardsOfTheMonth,
  cardsOfTheWeek,
  dateKey,
  parseDateKey,
} from "./deterministic";
import { composeDaily, composeMonthly, composeWeek, type FortuneSegment } from "./compose";

/** 每日 + 本周的组装结果 */
export interface DailyContent {
  d: Date;
  daily: { card: ReturnType<typeof cardOfTheDay>["card"]; reversed: boolean };
  dailySeg: FortuneSegment;
  weekSegs: FortuneSegment[];
}

/**
 * 组装某一天的每日之牌 + 本周七牌
 *
 * ⚠️ 纯函数 —— 客户端组件可以安全调用。
 *
 * @returns null = 日期格式非法
 */
export function buildDailyContent(date: string): DailyContent | null {
  const d = parseDateKey(date);
  if (!d) return null;
  const daily = cardOfTheDay(d);
  const dailySeg = composeDaily(daily.card, daily.reversed, dateKey(d));
  const week = cardsOfTheWeek(d);
  const weekSegs = composeWeek(week, `${d.getFullYear()}-W${getWeekNumber(d)}`);
  return { d, daily, dailySeg, weekSegs };
}

/** ISO 周号 */
export function getWeekNumber(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - dayNum + 3);
  const firstThursday = new Date(t.getFullYear(), 0, 4);
  const diff = t.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

/** 月运（零成本拼装，纯函数） */
export function buildMonthlyContent(date: Date) {
  const items = cardsOfTheMonth(date);
  const label = `${date.getFullYear()}年${date.getMonth() + 1}月`;
  return { items, segments: composeMonthly(items, label), label };
}
