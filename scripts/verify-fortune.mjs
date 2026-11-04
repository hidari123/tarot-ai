#!/usr/bin/env node
/**
 * 验证：运势矩阵（每日 / 周 / 月 / 季 / 年运流年）—— 2026-11-04 C 方向
 *
 * ⚠️ 为什么需要这份脚本：
 *   运势是**内容型**功能，最容易悄悄坏掉的地方：
 *     · 确定性被破坏（刷新就变 → 预生成失效 → SEO 归零）
 *     · 客户端组件间接引入 db.ts（better-sqlite3 原生模块 → 构建失败）
 *     · `new Date()` 在预渲染期触发 unstable value（构建直接失败）
 *     · 纯函数层与 server 层没分开（client bundle 爆炸）
 *
 * 断言分五组：
 *   ① 确定性（核心契约）
 *   ② 分层（纯函数 vs server-only）
 *   ③ 文案组装（零成本路径）
 *   ④ LLM 缓存（年运/流年/四季）
 *   ⑤ 页面与 SEO
 *
 * 用法：npx tsx scripts/verify-fortune.mjs
 */

import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

console.log("=== 运势矩阵验证 ===\n");

/* ────────────── ① 确定性 ────────────── */
console.log("【① 确定性】（核心契约：同一天永远同一张牌）");
{
  const det = await import("../src/lib/fortune/deterministic.ts").catch((e) => ({ __err: e }));
  if (det.__err) {
    check("能 import 确定性模块", false, String(det.__err).slice(0, 90));
  } else {
    check("能 import 确定性模块", true);
    const d = new Date(2026, 10, 4, 12);

    // ① 同一天多次调用一致
    const a = det.cardOfTheDay(d);
    const b = det.cardOfTheDay(new Date(2026, 10, 4, 23, 59));
    check("同一天不同时刻 → 同一张牌", a.card.id === b.card.id, `${a.card.nameZh}`);
    check("同一天 → 逆位状态也一致", a.reversed === b.reversed);

    // ② 相邻日期通常不同
    const next = det.cardOfTheDay(new Date(2026, 10, 5, 12));
    check("相邻日期通常不同（不是天天同一张）", next.card.id !== a.card.id, next.card.nameZh);

    // ③ 一周七牌不重复
    const week = det.cardsOfTheWeek(d);
    check("一周七牌不重复", new Set(week.map((w) => w.card.id)).size === 7, `${new Set(week.map((w) => w.card.id)).size}/7`);

    // ④ ⚠️ 实测踩过的坑：同周任意一天必须一致
    const week2 = det.cardsOfTheWeek(new Date(2026, 10, 6, 12));
    check(
      "同周任意一天 → 同一组牌（周一与周日看到的一致）",
      week.every((w, i) => w.card.id === week2[i].card.id),
      "实测踩坑：原来用当前日期做种子 → 周内不同日结果不同"
    );

    // ⑤ 月运三张 / 四季五张
    check("月运三张（上中下旬）", det.cardsOfTheMonth(d).length === 3);
    check("四季牌阵五张", det.cardsOfTheSeason(d).length === 5);

    // ⑥ 年运 = 1 主题 + 12 月，且稳定
    const year = det.cardsOfTheYear(2026);
    check("年运有 1 张主题牌", !!year.theme?.card);
    check("流年有 12 个月", year.months.length === 12);
    const yearAgain = det.cardsOfTheYear(2026);
    check(
      "年运 12 个月稳定（可在年初一次性预生成）",
      year.months.every((m, i) => m.card.id === yearAgain.months[i].card.id)
    );

    // ⑦ 逆位率 ~30%（竞品 Tarot Run 的说法）
    let rev = 0;
    for (let i = 0; i < 365; i++) {
      if (det.cardOfTheDay(new Date(2026, 0, 1 + i, 12)).reversed) rev++;
    }
    const rate = (rev / 365) * 100;
    check("逆位率在 20%~40% 之间（竞品约 30%）", rate >= 20 && rate <= 40, `${rate.toFixed(1)}%`);

    // ⑧ 日期解析健壮性
    check("合法日期可解析", !!det.parseDateKey("2026-11-04"));
    check("非法日期返回 null（不崩）", det.parseDateKey("abc") === null && det.parseDateKey("") === null);
    check("dateKey 输出 YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(det.dateKey(d)));
  }
}

/* ────────────── ② 分层（客户端/服务端边界） ────────────── */
console.log("\n【② 分层】（客户端组件绝不能碰原生模块）");
{
  const build = readFileSync("src/lib/fortune/build.ts", "utf-8");
  const buildCode = strip(build);

  check("build.ts 是纯函数层（不 import db / llm）",
    !/from "\.\/fortune-cache"/.test(buildCode) && !/from "\.\.\/db"/.test(buildCode));
  check("build.ts 不引入 server-only 模块",
    !/fortune-cache|llm-providers|agent\/llm/.test(buildCode));
  check("server.ts 承担 LLM/DB 职责", existsSync("src/lib/fortune/server.ts"));
  const server = readFileSync("src/lib/fortune/server.ts", "utf-8");
  check("server.ts 导出年运与四季的取数", /buildYearContent/.test(server) && /buildSeasonContent/.test(server));

  const dailyComp = readFileSync("src/components/DailyFortune.tsx", "utf-8");
  check("客户端组件只 import 纯函数层", /@\/lib\/fortune\/build/.test(dailyComp));
  check("客户端组件不 import server 层", !/@\/lib\/fortune\/server/.test(dailyComp));
  check("客户端组件不直接 import db", !/from "@\/lib\/db"/.test(dailyComp));
}

/* ────────────── ③ 文案组装 ────────────── */
console.log("\n【③ 文案组装】（零 LLM 成本路径）");
{
  const compose = await import("../src/lib/fortune/compose.ts").catch((e) => ({ __err: e }));
  if (compose.__err) {
    check("能 import 文案模块", false, String(compose.__err).slice(0, 90));
  } else {
    check("能 import 文案模块", true);
    const det = await import("../src/lib/fortune/deterministic.ts");
    const d = new Date(2026, 10, 4, 12);

    const daily = compose.composeDaily(det.cardOfTheDay(d).card, false, "2026-11-04");
    check("每日文案有正文", daily.text.length > 40, `${daily.text.length} 字`);
    check("每日文案含牌意", daily.meaning.length > 0);
    check("每日文案有关键词", daily.keywords.length > 0, daily.keywords.join("/"));

    const week = compose.composeWeek(det.cardsOfTheWeek(d), "2026-W44");
    check("周文案 7 段", week.length === 7);
    check("周文案每段都有内容", week.every((w) => w.text.length > 5));

    const monthly = compose.composeMonthly(det.cardsOfTheMonth(d), "2026年11月");
    check("月文案 3 段", monthly.length === 3);
    check("月文案每段都有内容", monthly.every((m) => m.text.length > 20));

    const seasonal = compose.composeSeason(det.cardsOfTheSeason(d), "season:2026:秋");
    check("季文案 5 段", seasonal.length === 5);

    const yearData = det.cardsOfTheYear(2026);
    const yearly = compose.composeYear(yearData.theme, yearData.months, 2026);
    check("年文案有主题 + 12 月", !!yearly.theme.text && yearly.months.length === 12);

    // ⚠️ 模板多样化：不同日期的文案不应该完全一样
    const t1 = compose.composeDaily(det.cardOfTheDay(new Date(2026, 10, 4)).card, false, "2026-11-04").text;
    const t2 = compose.composeDaily(det.cardOfTheDay(new Date(2026, 10, 5)).card, false, "2026-11-05").text;
    check("不同日期文案不完全相同（模板有轮换）", t1 !== t2);
  }
}

/* ────────────── ④ LLM 缓存 ────────────── */
console.log("\n【④ LLM 缓存】（年运/流年/四季一次性生成）");
{
  const cache = readFileSync("src/lib/fortune/fortune-cache.ts", "utf-8");
  const cacheCode = strip(cache);
  const dbSrc = readFileSync("src/lib/db.ts", "utf-8");
  const dbCode = strip(dbSrc);

  check("fortune_cache 表在 db.ts 里建（不运行时建表）",
    /CREATE TABLE IF NOT EXISTS fortune_cache/.test(dbCode));
  check("db.ts 暴露缓存读写 API",
    /export function readFortuneCacheRow/.test(dbCode) &&
    /export function writeFortuneCacheRow/.test(dbCode));
  check("缓存 key 按年/季区分", /`year:\$\{year\}`/.test(cacheCode) && /`season:\$\{seasonYear\}:\$\{season\}`/.test(cacheCode));
  check("年运有并发去重（同一 key 只生成一次）", /withInflightGuard/.test(cacheCode));
  check("LLM 失败会降级到拼装（不白屏）",
    /generated: false/.test(cacheCode) && /composeYear/.test(cacheCode));
  check("年运 LLM 输出要求 JSON 且 12 段",
    /parsed\.months\.length !== 12/.test(cacheCode));
}

/* ────────────── ⑤ 页面与 SEO ────────────── */
console.log("\n【⑤ 页面与 SEO】");
{
  const dailyPage = readFileSync("src/app/daily/[date]/page.tsx", "utf-8");
  const dailyCode = strip(dailyPage);

  check("每日之牌有 generateStaticParams（SEO 预生成）", /export function generateStaticParams/.test(dailyCode));
  check("generateStaticParams 返回至少一个 param（Next 16 硬要求）",
    /dateKeysForPrerender\(\)\.map/.test(dailyCode) && !/return \[\]/.test(dailyCode));
  check("预生成范围覆盖过去 7 天 + 未来 30 天",
    /PAST_DAYS = 7/.test(dailyCode) && /FUTURE_DAYS = 30/.test(dailyCode));
  check("有 generateMetadata（SEO 关键）", /export async function generateMetadata/.test(dailyCode));
  check("params 的 await 包在 Suspense 内（Next 16 要求）", /<Suspense/.test(dailyCode));

  // ⚠️ PPR：new Date() 必须在 connection() 之后
  for (const p of ["src/app/fortune/page.tsx", "src/app/fortune/monthly/page.tsx", "src/app/fortune/seasonal/page.tsx", "src/app/fortune/yearly/page.tsx"]) {
    const src = readFileSync(p, "utf-8");
    const code = strip(src);
    const hasConn = /await connection\(\)/.test(code);
    const hasNewDate = /new Date\(\)/.test(code);
    check(`${p.replace("src/app/", "")}：有 new Date 就有 connection()`, !hasNewDate || hasConn);
    check(`${p.replace("src/app/", "")}：有 Suspense 边界`, /<Suspense/.test(code));
    // ⚠️ fallback 里不能有 new Date（实测踩坑）
    const fb = code.match(/fallback=\{[\s\S]*?\}/);
    check(`${p.replace("src/app/", "")}：fallback 里没有动态值`, !fb || !/new Date\(\)/.test(fb[0]));
  }

  check("运势专区页存在", existsSync("src/app/fortune/page.tsx"));
  check("月运页存在", existsSync("src/app/fortune/monthly/page.tsx"));
  check("四季页存在", existsSync("src/app/fortune/seasonal/page.tsx"));
  check("年运页存在", existsSync("src/app/fortune/yearly/page.tsx"));
  check("年运页用的是 server 层（LLM）", /@\/lib\/fortune\/server/.test(readFileSync("src/app/fortune/yearly/page.tsx", "utf-8")));
  check("月运页用的是纯函数层（零成本）", /@\/lib\/fortune\/build/.test(readFileSync("src/app/fortune/monthly/page.tsx", "utf-8")));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
