/**
 * 年运 / 流年 / 四季的**一次性生成 + 全年缓存**
 *
 * ⚠️⚠️ 为什么这三类要用 LLM，而每日/月运不用：
 *   · 每日之牌 —— 每天都要更新，量太大 → 必须零成本（compose.ts 拼装）
 *   · 月运 —— 每月更新，量可控 → 零成本拼装即可
 *   · **年运 / 流年 / 四季** —— 一年只有一次更新（四季 4 次）→ 值得付费
 *     且它们是**用户停留最久的页面**（一整年的运势）→ 质量直接影响体验。
 *
 * ⚠️ 成本可控的算术：
 *   年运 1 次 + 流年 12 段 + 四季 4 次 ≈ 17 次 LLM 调用 / 年 ≈ ¥0.2/年
 *   （对比"每天生成一次"= 365 次/年 ≈ ¥4.4/年，且质量没提升）
 *
 * ⚠️ 缓存策略（DB）：
 *   · 表 `fortune_cache(cache_key PK, payload_json, created_at)`
 *   · key = "year:2026" / "season:2026-autumn" / "year-months:2026"
 *   · 命中就直接用 → 零 LLM 成本、零延迟
 *   · 未命中 → 生成 → 落库 → 下次命中
 *
 * ⚠️ 降级原则（必须）：
 *   LLM 不可用 / 超时 / 解析失败 → **回落到拼装版本**（compose.ts），
 *   功能永远可用，只是文案质量降一档。**绝不能**因为 LLM 挂了而白屏。
 */

import * as db from "../db";
import { buildProviders, pickProvider } from "../llm-providers";
import { callLLM } from "../agent/llm";
import { runtimeState } from "../runtime";
import type { TarotCard } from "../tarot-cards";
import { composeSeason, composeYear, type FortuneSegment } from "./compose";
import { cardsOfTheSeason, cardsOfTheYear, seasonNameOf } from "./deterministic";

/* ------------------------------------------------------------------ */
/* 缓存表                                                              */
/* ------------------------------------------------------------------ */

/**
 * 确保运势缓存表存在
 *
 * ⚠️ 表已在 db.ts 的建表 SQL 里创建（与其他表一起，避免首次请求才建表）。
 *   这个函数保留为**幂等兜底**（老库升级场景）—— 失败不影响功能。
 */
export function ensureFortuneTable(): void {
  try {
    db.execRaw(`
      CREATE TABLE IF NOT EXISTS fortune_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  } catch { /* 建表失败不阻断（缓存 miss 时会走生成/降级） */ }
}

/** 读缓存 */
export function readFortuneCache(key: string): unknown | null {
  try {
    const row = db.readFortuneCacheRow(key);
    if (!row) return null;
    return JSON.parse(row.payload_json);
  } catch {
    return null;
  }
}

/** 写缓存 */
export function writeFortuneCache(key: string, payload: unknown): void {
  try {
    db.writeFortuneCacheRow(key, JSON.stringify(payload), Date.now());
  } catch { /* 写缓存失败不阻断 */ }
}

/* ------------------------------------------------------------------ */
/* 年运 + 流年                                                         */
/* ------------------------------------------------------------------ */

/** 年运缓存载荷 */
export interface YearFortune {
  year: number;
  themeNameZh: string;
  themeReversed: boolean;
  themeText: string;
  themeKeywords: string[];
  /** 12 个月的解读 */
  months: Array<{
    month: number;
    nameZh: string;
    reversed: boolean;
    text: string;
    keywords: string[];
  }>;
  /** 是否是 LLM 生成的（false = 降级拼装） */
  generated: boolean;
}

/**
 * 取年运（含 12 个月流年）
 *
 * ⚠️ 流程：缓存命中 → 直接返回；未命中 → LLM 生成 → 落缓存 → 返回；
 *   LLM 失败 → 拼装降级（不落缓存，因为下次还会再试 LLM）。
 */
export async function getYearFortune(year: number): Promise<YearFortune> {
  const cacheKey = `year:${year}`;
  const cached = readFortuneCache(cacheKey);
  if (cached && typeof cached === "object" && "months" in (cached as object)) {
    return cached as YearFortune;
  }

  // ⚠️ 并发去重：同一 key 只生成一次（否则并发请求会重复花钱）
  return withInflightGuard(cacheKey, async () => {
    // ⚠️ 双检：等锁期间可能已经被别的请求生成好了
    const again = readFortuneCache(cacheKey);
    if (again && typeof again === "object" && "months" in (again as object)) {
      return again as YearFortune;
    }
    return generateAndStoreYear(year);
  });
}

/** 生成并落库年运（内部） */
async function generateAndStoreYear(year: number): Promise<YearFortune> {
  const cacheKey = `year:${year}`;
  const { theme, months } = cardsOfTheYear(year);

  // ---- 尝试 LLM 生成 ----
  const generated = await generateYearText(year, theme, months);
  if (generated) {
    const payload: YearFortune = {
      year,
      themeNameZh: theme.card.nameZh,
      themeReversed: theme.reversed,
      themeText: generated.themeText,
      themeKeywords: theme.card.keywords.slice(0, 3),
      months: months.map((m, i) => ({
        month: m.month,
        nameZh: m.card.nameZh,
        reversed: m.reversed,
        text: generated.monthTexts[i] ?? "",
        keywords: m.card.keywords.slice(0, 2),
      })),
      generated: true,
    };
    writeFortuneCache(cacheKey, payload);
    return payload;
  }

  // ---- 降级：拼装 ----
  const composed = composeYear(theme, months, year);
  return {
    year,
    themeNameZh: theme.card.nameZh,
    themeReversed: theme.reversed,
    themeText: composed.theme.text,
    themeKeywords: composed.theme.keywords,
    months: months.map((m, i) => ({
      month: m.month,
      nameZh: m.card.nameZh,
      reversed: m.reversed,
      text: composed.months[i].text,
      keywords: composed.months[i].keywords,
    })),
    generated: false,
  };
}

/**
 * 用 LLM 生成年运文本（主题 + 12 个月）
 *
 * ⚠️ 为什么要求输出 JSON：
 *   12 段文本用纯文本格式解析不可靠（分隔符易混）→ JSON 数组最稳。
 * ⚠️ 解析失败返回 null → 走降级。
 */
async function generateYearText(
  year: number,
  theme: { card: TarotCard; reversed: boolean },
  months: Array<{ card: TarotCard; reversed: boolean; month: number }>
): Promise<{ themeText: string; monthTexts: string[] } | null> {
  const providers = buildProviders();
  if (providers.length === 0) return null;
  const config = pickProvider() ?? providers[0];

  const monthBrief = months
    .map((m) => `${m.month}月：${m.card.nameZh}${m.reversed ? "（逆位）" : ""}｜${m.card.upright.slice(0, 30)}`)
    .join("\n");

  try {
    const res = await Promise.race([
      callLLM(
        config,
        [
          {
            role: "system",
            content:
              "你是塔罗运势作者。为用户写一整年的塔罗年运与流年。\n" +
              "⚠️ 只输出一个 JSON 对象，不要 markdown 代码块、不要任何解释文字。\n" +
              '格式：{"theme":"主题段正文","months":["1月正文","2月正文",...,"12月正文"]}\n' +
              "⚠️ 要求：\n" +
              "· theme：120~180 字，讲这一年的主线主题与要注意的事\n" +
              "· months：每项 40~70 字，讲那个月的重点\n" +
              "· 语气：温和、具体、不说教、不预测具体事件（避免宿命论）\n" +
              "· 必须紧扣给出的牌名与牌意，不要泛泛而谈",
          },
          {
            role: "user",
            content:
              `年份：${year}\n` +
              `年度主题牌：${theme.card.nameZh}${theme.reversed ? "（逆位）" : ""}\n` +
              `主题牌意：${theme.reversed ? theme.card.reversed : theme.card.upright}\n` +
              `主题关键词：${theme.card.keywords.join("、")}\n\n` +
              `流年各月牌：\n${monthBrief}`,
          },
        ],
        undefined,
        "fortune_year",
        "writer"
      ),
      new Promise<null>((r) => setTimeout(() => r(null), 90_000)),
    ]);

    if (!res) return null;
    const raw = (res.message.content ?? "").trim();
    const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = json.indexOf("{");
    const end = json.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(json.slice(start, end + 1)) as { theme?: string; months?: string[] };
    if (!parsed.theme || !Array.isArray(parsed.months) || parsed.months.length !== 12) return null;
    return { themeText: String(parsed.theme).trim(), monthTexts: parsed.months.map((m) => String(m ?? "").trim()) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 四季牌阵                                                            */
/* ------------------------------------------------------------------ */

/** 四季缓存载荷 */
export interface SeasonFortune {
  year: number;
  season: string;
  segments: Array<{
    pos: string;
    nameZh: string;
    reversed: boolean;
    text: string;
    keywords: string[];
  }>;
  generated: boolean;
}

/**
 * 取四季牌阵
 *
 * ⚠️ 缓存 key 用"年+季" —— 同一季内所有日期共享同一份内容。
 */
export async function getSeasonFortune(date: Date): Promise<SeasonFortune> {
  const season = seasonNameOf(date);
  const m = date.getMonth() + 1;
  const seasonYear = season === "冬" && m <= 2 ? date.getFullYear() - 1 : date.getFullYear();
  const cacheKey = `season:${seasonYear}:${season}`;

  const cached = readFortuneCache(cacheKey);
  if (cached && typeof cached === "object" && "segments" in (cached as object)) {
    return cached as SeasonFortune;
  }

  // ⚠️ 并发去重（同 key 只生成一次）
  return withInflightGuard(cacheKey, async () => {
    const again = readFortuneCache(cacheKey);
    if (again && typeof again === "object" && "segments" in (again as object)) {
      return again as SeasonFortune;
    }
    return generateAndStoreSeason(date, seasonYear, season, cacheKey);
  });
}

/** 生成并落库四季运势（内部） */
async function generateAndStoreSeason(
  date: Date,
  seasonYear: number,
  season: string,
  cacheKey: string
): Promise<SeasonFortune> {
  const items = cardsOfTheSeason(date);

  const generated = await generateSeasonText(seasonYear, season, items);
  if (generated) {
    const payload: SeasonFortune = {
      year: seasonYear,
      season,
      segments: items.map((it, i) => ({
        pos: it.pos,
        nameZh: it.card.nameZh,
        reversed: it.reversed,
        text: generated[i] ?? "",
        keywords: it.card.keywords.slice(0, 3),
      })),
      generated: true,
    };
    writeFortuneCache(cacheKey, payload);
    return payload;
  }

  const composed = composeSeason(items, cacheKey);
  return {
    year: seasonYear,
    season,
    segments: composed.map((s, i) => ({
      pos: items[i].pos,
      nameZh: s.nameZh,
      reversed: s.reversed,
      text: s.text,
      keywords: s.keywords,
    })),
    generated: false,
  };
}

/** 用 LLM 生成四季文本（5 段） */
async function generateSeasonText(
  year: number,
  season: string,
  items: Array<{ card: TarotCard; reversed: boolean; pos: string }>
): Promise<string[] | null> {
  const providers = buildProviders();
  if (providers.length === 0) return null;
  const config = pickProvider() ?? providers[0];

  const brief = items
    .map((it) => `${it.pos}：${it.card.nameZh}${it.reversed ? "（逆位）" : ""}｜${(it.reversed ? it.card.reversed : it.card.upright).slice(0, 30)}`)
    .join("\n");

  try {
    const res = await Promise.race([
      callLLM(
        config,
        [
          {
            role: "system",
            content:
              "你是塔罗运势作者。写一季的塔罗牌阵解读。\n" +
              "⚠️ 只输出一个 JSON 数组，不要 markdown 代码块、不要解释文字。\n" +
              '格式：["第一段","第二段","第三段","第四段","第五段"]\n' +
              "⚠️ 每段 50~90 字，紧扣该段给的牌与牌位，语气温和具体。",
          },
          {
            role: "user",
            content: `${year} 年 ${season}季\n\n${brief}`,
          },
        ],
        undefined,
        "fortune_season",
        "writer"
      ),
      new Promise<null>((r) => setTimeout(() => r(null), 60_000)),
    ]);

    if (!res) return null;
    const raw = (res.message.content ?? "").trim();
    const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = json.indexOf("[");
    const end = json.lastIndexOf("]");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(json.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== items.length) return null;
    return parsed.map((t) => String(t ?? "").trim());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 内存缓存（避免同一进程内重复生成）                                  */
/* ------------------------------------------------------------------ */

/**
 * 进程内缓存
 *
 * ⚠️ 为什么需要（DB 缓存已经够了，为什么还要内存）：
 *   同一进程内多个请求同时命中同一个未缓存的 key → 会**并发触发多次 LLM 生成**
 *   → 重复花钱。内存里的 Promise 缓存能保证"同一 key 只生成一次"。
 */
const inflight = runtimeState<Map<string, Promise<unknown>>>(
  "fortune.inflight",
  () => new Map<string, Promise<unknown>>()
);

/**
 * 带并发去重的缓存包装
 */
export async function withInflightGuard<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/** 导出 FortuneSegment 类型（页面用） */
export type { FortuneSegment };
