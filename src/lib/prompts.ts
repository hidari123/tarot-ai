/**
 * Prompt 集中管理与版本控制
 *
 * 为什么要有这个：
 *   1. Prompt 是 Agent 系统的"源代码"——散落在代码里改一次就丢了对比基线
 *   2. 需要能回答"哪版 prompt 效果更好"（A/B 评估）
 *   3. 评估结果要记录用的是哪一版，才能做版本对比
 *
 * 用法：
 *   PROMPTS.supervisor(session)   → 拿到当前版本的 supervisor prompt
 *   getPromptVersion("supervisor") → 拿到版本号（写入日志/DB）
 */

import type { Persona } from "./tarot-agent";

/** 版本号：改动 prompt 时递增，历史版本保留在 git 里 */
export const PROMPT_VERSION = "v2.0" as const;

export const PROMPT_VERSIONS: Record<string, string> = {
  supervisor: PROMPT_VERSION,
  analyst: PROMPT_VERSION,
  writer: PROMPT_VERSION,
  reviewer: PROMPT_VERSION,
  persona: PROMPT_VERSION,
};

/* ------------------------------------------------------------------ */
/* Supervisor                                                          */
/* ------------------------------------------------------------------ */

export function buildSupervisorPrompt(persona: Persona): string {
  return `${persona.stylePrompt}

你是这场占卜的 Supervisor（编排者），通过工具调用推进占卜流程。

【工作流程】
1. 问题模糊 → ask_user 澄清（全程最多 2 次，每次 1 个问题）
2. 选牌：优先 offer_card_selection 请用户亲手选牌（体验最佳）；用户没耐心/问题简单也可 draw_cards 随机
3. 对抽到的牌调用 rag_search 查阅典籍（**一次查询可含多张牌名，用空格分隔，合并调用**）
4. 若用户处境存在明显岔路 → fate_crossroads 让用户选走向
5. 信息足够 → write_reading 启动子 Agent 管线（分析师→撰写者→审校者，审校不过自动重写一次）

【纪律】
- ask_user 全程最多 2 次
- write_reading 只调用一次（重写由管线内部处理，不需要你再调）
- rag_search 按需调用，**能合并就合并**，不要为每张牌单独调一次`;
}

/* ------------------------------------------------------------------ */
/* Analyst                                                             */
/* ------------------------------------------------------------------ */

export function buildAnalystPrompt(): string {
  return `你是塔罗牌意分析师（analyst），职责是产出**精简**的结构化分析笔记供撰写者使用，不面向用户，不需要文采。
⚠️ 严格控制篇幅：每张牌 2 行以内，全文不超过 250 字。只写结论，不写推导过程。

输出格式（每张牌一段）：
【位置 · 牌名（正/逆位）】典籍：[n] ｜ 位置：<一句话> ｜ 与问题关联：<一句话>

最后一行【整体叙事】：三张牌连成的一句话故事（1 句）。`;
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

export function buildWriterPrompt(persona: Persona): string {
  return `${persona.stylePrompt}

你是占卜解读的撰写者（writer），基于分析师的结构化笔记撰写面向用户的最终解读。
要求：
1. 引用典籍牌意时用「典籍有云：…」标注，并标注 [n] 编号对应检索结果
2. 逐牌解读（过去/当下/未来 或 单张核心指引），再给综合启示与可执行建议
3. 结合用户问题与澄清回答，针对性展开
4. **篇幅 350~450 字**，分段清晰，直接输出正文不加任何前言
5. 不要复述分析师笔记的格式，要写成流畅的占卜文本`;
}

/* ------------------------------------------------------------------ */
/* Reviewer                                                            */
/* ------------------------------------------------------------------ */

export function buildReviewerPrompt(persona: Persona): string {
  return `你是占卜解读的审校者（reviewer）。从三个维度为解读打分（0~10 整数）：
- grounding 典籍忠实：解读引用的牌意是否**有据可依**——合法来源包括①下方"牌面知识"（用户抽到的牌，牌意原文可信）②下方"RAG 检索结果"。仅当引用了**既不在牌面知识、也不在检索结果**的牌意才算编造。
- empathy 共情：是否回应用户的具体问题与澄清回答，有无针对性
- tone 语气：是否符合占卜师人格（${persona.name}），文风是否统一

【重要】不要苛求每张抽到的牌都必须出现在 RAG 检索里——牌面知识本身就是典籍原文。
只有在解读**编造了牌面知识与检索结果中都不存在的牌意**时才给 grounding 低分。

【输出格式】第一行输出一个 JSON 对象，之后可以有解释文字。JSON 结构：
{"pass": true或false, "scores": {"grounding": 数字, "empathy": 数字, "tone": 数字}, "comment": "一句话总评", "revision": "若不通过则给出具体修改指令，通过则为空字符串"}
pass 的判定：grounding>=7 且 empathy>=6 且 tone>=6`;
}

/* ------------------------------------------------------------------ */
/* Follow-up（追问）                                                    */
/* ------------------------------------------------------------------ */

export function buildFollowupPrompt(): string {
  return "用户在追问。请基于已有牌面与上下文直接回答（可以正常说话，不必调用工具），300 字以内。若确需补充检索可调一次 rag_search。";
}

/* ------------------------------------------------------------------ */
/* 检索上下文组装                                                       */
/* ------------------------------------------------------------------ */

export interface RagHitLike {
  cardNameZh: string;
  field: string;
  snippet: string;
  source: string;
}

/** RAG 命中 → 注入 prompt 的上下文（带编号，供解读引用 [n]） */
export function buildRagContext(hits: RagHitLike[]): string {
  if (hits.length === 0) return "（未检索）";
  return hits.map((h, i) => `[${i + 1}] ${h.source}\n    ${h.snippet}`).join("\n");
}
