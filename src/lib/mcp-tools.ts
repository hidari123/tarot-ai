/**
 * MCP 工具实现 —— 与传输层解耦（可被 mcp-server.mjs 与测试直接复用）
 *
 * P3-⑨：把占卜能力包成原子工具。MCP 场景下客户端 AI 自己编排对话，
 * 我们提供无状态能力（抽牌/解读/检索）——
 * 与 Web 前端的整场 HITL 仪式是互补关系，不是替代。
 */

import { z } from "zod";
import { randomInt } from "node:crypto";

// 由调用方注入（避免测试时重复加载/循环依赖）
export interface McpDeps {
  TAROT_CARDS: import("./tarot-cards").TarotCard[];
  hybridSearch: (query: string, topK: number) => Promise<
    Array<{ cardNameZh: string; field: string; score: number; snippet: string; channels?: string[] }>
  >;
}

/* ------------------------------------------------------------------ */
/* 工具 schema（MCP 客户端可见的参数契约）                              */
/* ------------------------------------------------------------------ */

export const DrawCardsSchema = z.object({
  spread: z.enum(["three", "single"]).default("three").describe("牌阵类型"),
  seed: z.number().int().optional().describe("随机种子（可复现，测试用）"),
});

export const InterpretCardsSchema = z.object({
  question: z.string().describe("用户的占卜问题"),
  cards: z
    .array(
      z.object({
        id: z.string().describe("牌 id（来自 draw_cards 返回）"),
        pos: z.string().describe("位置（过去/当下/未来/核心指引）"),
        reversed: z.boolean().describe("是否逆位"),
      })
    )
    .min(1)
    .max(3)
    .describe("已抽的牌列表"),
  focus: z.string().optional().describe("解读侧重（如'情感剖析'、'行动建议'）"),
});

export const SearchTarotSchema = z.object({
  query: z.string().min(1).describe("检索词（牌名或主题关键词，如'权杖七 坚持'）"),
  top_k: z.number().int().min(1).max(10).default(5).describe("返回条数"),
});

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

/** 简单可复现随机（seed 用） */
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DrawnCardInfo {
  id: string;
  nameZh: string;
  nameEn: string;
  pos: string;
  reversed: boolean;
  image: string;
  meaning: string;
  keywords: string[];
}

/** 抽牌：随机 N 张（不重复），含正逆位与牌意 */
export function drawCards(deps: McpDeps, spread: "three" | "single", seed?: number): DrawnCardInfo[] {
  const n = spread === "single" ? 1 : 3;
  const pool = [...deps.TAROT_CARDS];
  const drawn: Array<{ card: (typeof pool)[number]; reversed: boolean }> = [];
  const rng = seed ? mulberry32(seed) : null;
  const pick = (max: number) => (rng ? Math.floor(rng() * max) : randomInt(max));

  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = pick(pool.length);
    const card = pool.splice(idx, 1)[0];
    drawn.push({ card, reversed: pick(100) < 35 });
  }
  const posNames = ["过去", "当下", "未来"];
  return drawn.map((d, i) => ({
    id: d.card.id,
    nameZh: d.card.nameZh,
    nameEn: d.card.nameEn,
    pos: n === 1 ? "核心指引" : posNames[i],
    reversed: d.reversed,
    image: d.card.image,
    meaning: d.reversed ? d.card.reversed : d.card.upright,
    keywords: d.card.keywords ?? [],
  }));
}

/** 本地解读（规则式典籍牌意 —— 语言组织交给 MCP 客户端的 AI） */
export function interpretLocally(
  question: string,
  drawnCards: DrawnCardInfo[],
  focus?: string
): string {
  const parts: string[] = [];
  const posLabel: Record<string, string> = { 过去: "缘起", 当下: "现状", 未来: "走向", 核心指引: "核心" };
  parts.push(`问：${question}`);
  if (focus) parts.push(`侧重：${focus}`);
  parts.push("");
  for (const c of drawnCards) {
    parts.push(`【${posLabel[c.pos] ?? c.pos} · ${c.nameZh}${c.reversed ? "（逆位）" : ""}】${c.meaning}`);
    if (c.keywords?.length) parts.push(`  关键词：${c.keywords.join("、")}`);
  }
  parts.push("");
  parts.push("提示：以上为韦特牌典籍牌意。请结合提问者处境组织解读语言；占卜显示倾向，不是判决。");
  return parts.join("\n");
}

/** 检索典籍（格式化输出，带相关度与命中通道） */
export async function searchTarot(deps: McpDeps, query: string, topK: number): Promise<string> {
  const hits = await deps.hybridSearch(query, topK);
  const fieldLabel: Record<string, string> = {
    description: "牌面叙事", upright: "正位", reversed: "逆位", keywords: "关键词",
  };
  const formatted = hits.map((h, i) =>
    `[${i + 1}] ${h.cardNameZh} · ${fieldLabel[h.field] ?? h.field}（score ${h.score.toFixed(3)}，通道 ${h.channels?.join("+") ?? "-"}）\n    ${h.snippet}`
  );
  return formatted.length ? formatted.join("\n") : "（无命中）";
}
