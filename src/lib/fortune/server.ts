/**
 * 运势的 **server 端**接口（依赖 DB 与 LLM）
 *
 * ⚠️⚠️ 严格与 build.ts（纯函数层）分开：
 *   这个文件会引入 db.ts（better-sqlite3 原生模块）和 LLM 调用 ——
 *   **客户端组件绝不能引用它**（Next 打包原生模块会失败）。
 *   → 需要"年运 / 四季"的服务端页面从这里取数。
 *   → 需要"每日 / 月运"的任何端从 build.ts 取数（纯函数，客户端也安全）。
 */

import { getSeasonFortune, getYearFortune, type SeasonFortune, type YearFortune } from "./fortune-cache";

/** 年运 + 流年（LLM 一次性生成，缓存全年） */
export async function buildYearContent(year: number): Promise<YearFortune> {
  return getYearFortune(year);
}

/** 四季牌阵（LLM 一次性生成，按季缓存） */
export async function buildSeasonContent(date: Date): Promise<SeasonFortune> {
  return getSeasonFortune(date);
}
