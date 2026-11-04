/**
 * 运势内容的**确定性选取** —— 每日之牌 / 周 / 月 / 季 / 年
 *
 * ⚠️⚠️ 为什么必须确定性（不能随机）：
 *   1. 「每日之牌」的语义就是"今天这张" —— 随机会导致**刷新就变**，失去仪式感
 *      （用户会以为网站坏了）。
 *   2. 可**预生成静态页** → SEO（搜索引擎抓不到客户端渲染的内容）与零服务端开销。
 *   3. URL 可分享、可收藏（"/daily/2026-11-04" 永远指向同一张牌）。
 *
 * ⚠️ 为什么不用「日期数字直接取模」：
 *   2026-11-04 与 2026-12-04 相差 30 天 —— 虽然 30 % 78 ≠ 0，
 *   但"按天数取模"会让**不同月份的同一天号**产生规律性碰撞
 *   （每月 1 号都落在同一张牌附近）。
 *   → 用哈希散列：把日期字符串均匀打散到 78 张牌上。
 *
 * ⚠️ 逆位怎么定（竞品做法）：
 *   Tarot Run：「大約每十張中有三張會以逆位出現」→ 约 30% 逆位。
 *   我们用**独立种子**（日期 + "-rev"）决定正逆位 —— 同样确定性。
 */

import { TAROT_CARDS, type TarotCard } from "../tarot-cards";

/** 字符串哈希（FNV-1a 变体）—— 稳定、跨进程一致 */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 日期 → "YYYY-MM-DD"（用本地时区，避免 UTC 偏移导致"今天"错位） */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 解析 "YYYY-MM-DD" → Date（本地时区中午，避开夏令时边界） */
export function parseDateKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 逆位判定（确定性）
 *
 * ⚠️ 逆位率约 30% —— 与 Tarot Run 的说法一致（"每十张中有三张"）。
 */
export function isReversed(seed: string): boolean {
  return hashString(`${seed}:rev`) % 10 < 3;
}

/**
 * 今日之牌（确定性）
 */
export function cardOfTheDay(date: Date): { card: TarotCard; reversed: boolean } {
  const key = dateKey(date);
  const card = TAROT_CARDS[hashString(key) % TAROT_CARDS.length];
  return { card, reversed: isReversed(key) };
}

/**
 * 一周之牌（7 张）
 *
 * ⚠️ 用「**周一**的日期」做种子 —— 这样**同一周的任意一天**算出来都是同一组牌
 *   （用户周一来看和周日来看，应该看到同一周的内容）。
 * ⚠️ ⚠️ 实测踩过的坑：原来用"当前日期"做种子 → 周一和周日的两组牌不同
 *   → 用户会发现"这一周的牌变了"（很违和）。
 */
export function cardsOfTheWeek(date: Date): Array<{ card: TarotCard; reversed: boolean; dayOffset: number }> {
  const monday = startOfWeek(date);
  const weekKey = dateKey(monday);
  const out: Array<{ card: TarotCard; reversed: boolean; dayOffset: number }> = [];
  for (let i = 0; i < 7; i++) {
    const seed = `${weekKey}:w${i}`;
    out.push({
      card: TAROT_CARDS[hashString(seed) % TAROT_CARDS.length],
      reversed: isReversed(seed),
      dayOffset: i,
    });
  }
  return out;
}

/**
 * 取某日期所在周的**周一**（周一为一周之始）
 */
export function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  const dayIdx = (d.getDay() + 6) % 7; // 周一=0 … 周日=6
  d.setDate(d.getDate() - dayIdx);
  return d;
}

/**
 * 月运三张（上旬 / 中旬 / 下旬）
 */
export function cardsOfTheMonth(date: Date): Array<{ card: TarotCard; reversed: boolean; period: string }> {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const periods = ["上旬", "中旬", "下旬"];
  return periods.map((period, i) => {
    const seed = `${y}-${m}:m${i}`;
    return {
      card: TAROT_CARDS[hashString(seed) % TAROT_CARDS.length],
      reversed: isReversed(seed),
      period,
    };
  });
}

/**
 * 四季牌阵（5 张）
 *
 * ⚠️ 季度划分按**自然季**（3-5 / 6-8 / 9-11 / 12-2），
 *   而非气象季 —— 塔罗语境下"四季"更接近自然节气。
 * ⚠️ 种子用"年 + 季"→ 同一季内的所有日期算出来都是同一组牌。
 */
export function cardsOfTheSeason(date: Date): Array<{ card: TarotCard; reversed: boolean; pos: string }> {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  // 自然季：3-5 春 / 6-8 夏 / 9-11 秋 / 12-2 冬（12、1、2 属于同一个"冬"）
  const seasonIdx = m >= 3 && m <= 5 ? 0 : m >= 6 && m <= 8 ? 1 : m >= 9 && m <= 11 ? 2 : 3;
  // ⚠️ 冬季跨年：12 月属于"当年冬"，1-2 月属于"上一年冬"
  const seasonYear = seasonIdx === 3 && m <= 2 ? y - 1 : y;
  const positions = ["起点", "展开", "阻碍", "转机", "落点"];
  return positions.map((pos, i) => {
    const seed = `${seasonYear}:${seasonIdx}:s${i}`;
    return {
      card: TAROT_CARDS[hashString(seed) % TAROT_CARDS.length],
      reversed: isReversed(seed),
      pos,
    };
  });
}

/**
 * 年运（1 张主题牌）+ 流年 12 个月（每月一张）
 *
 * ⚠️ 种子用**年份** → 2026 全年 12 个月的牌在年初就能全部确定
 *   → 可以一次性生成并缓存全年（见 fortune-cache.ts）。
 */
export function cardsOfTheYear(year: number): {
  theme: { card: TarotCard; reversed: boolean };
  months: Array<{ card: TarotCard; reversed: boolean; month: number }>;
} {
  const themeSeed = `${year}:theme`;
  const theme = {
    card: TAROT_CARDS[hashString(themeSeed) % TAROT_CARDS.length],
    reversed: isReversed(themeSeed),
  };
  const months = Array.from({ length: 12 }, (_, i) => {
    const seed = `${year}:mo${i + 1}`;
    return {
      card: TAROT_CARDS[hashString(seed) % TAROT_CARDS.length],
      reversed: isReversed(seed),
      month: i + 1,
    };
  });
  return { theme, months };
}

/** 季节名（对外用） */
export function seasonNameOf(date: Date): string {
  const m = date.getMonth() + 1;
  return m >= 3 && m <= 5 ? "春" : m >= 6 && m <= 8 ? "夏" : m >= 9 && m <= 11 ? "秋" : "冬";
}
