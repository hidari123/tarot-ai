#!/usr/bin/env node
/**
 * 诊断：验证运势的**确定性**（同一天必须永远同一张牌）
 *
 * ⚠️ 这是运势功能的**核心契约**：
 *   随机会导致刷新就变、无法预生成静态页、URL 不可分享。
 */
import {
  cardOfTheDay,
  cardsOfTheWeek,
  cardsOfTheMonth,
  cardsOfTheSeason,
  cardsOfTheYear,
  dateKey,
} from "../../src/lib/fortune/deterministic.ts";

console.log("=== 运势确定性验证 ===\n");

const d = new Date(2026, 10, 4, 12);
const key = dateKey(d);

// ① 同一天多次调用结果一致
const a = cardOfTheDay(d);
const b = cardOfTheDay(d);
console.log(`每日之牌一致: ${a.card.id === b.card.id && a.reversed === b.reversed} (${a.card.nameZh}${a.reversed ? "逆" : ""})`);

// ② 不同进程调用一致（重新 import 同一模块再取）
const c = cardOfTheDay(new Date(2026, 10, 4, 23, 59));
console.log(`不同时刻同一日一致: ${c.card.id === a.card.id} (${c.card.nameZh})`);

// ③ 相邻日期通常不同（不能天天同一张）
const next = cardOfTheDay(new Date(2026, 10, 5, 12));
console.log(`相邻日期通常不同: ${next.card.id !== a.card.id} (${next.card.nameZh})`);

// ④ 一周内 7 张不重复
const week = cardsOfTheWeek(d);
const uniq = new Set(week.map((w) => w.card.id));
console.log(`一周七牌不重复: ${uniq.size}/7 (实际 ${uniq.size})`);

// ⑤ 一周内任意一天算出的周牌阵相同
const week2 = cardsOfTheWeek(new Date(2026, 10, 6, 12));
const same = week.every((w, i) => w.card.id === week2[i].card.id);
console.log(`同周任意一天结果一致: ${same}`);

// ⑥ 月运三张
const month = cardsOfTheMonth(d);
console.log(`月运三张: ${month.map((m) => m.card.nameZh).join(" / ")}`);

// ⑦ 季度五张
const season = cardsOfTheSeason(d);
console.log(`四季牌阵: ${season.map((s) => `${s.pos}·${s.card.nameZh}`).join(" / ")}`);

// ⑧ 年运 = 1 主题 + 12 月
const year = cardsOfTheYear(2026);
console.log(`年运主题: ${year.theme.card.nameZh}${year.theme.reversed ? "（逆）" : ""}`);
console.log(`流年 12 月: ${year.months.map((m) => m.card.nameZh).join(", ")}`);

// ⑨ 年运的月份牌在年初就确定（可一次性生成全年）
const yearAgain = cardsOfTheYear(2026);
const stable = year.months.every((m, i) => m.card.id === yearAgain.months[i].card.id);
console.log(`年运 12 月稳定可预生成: ${stable}`);

// ⑩ 逆位率约 30%
let rev = 0, total = 0;
for (let i = 0; i < 365; i++) {
  const dd = new Date(2026, 0, 1 + i, 12);
  total++;
  if (cardOfTheDay(dd).reversed) rev++;
}
console.log(`逆位率: ${((rev / total) * 100).toFixed(1)}% (目标 ~30%)`);
