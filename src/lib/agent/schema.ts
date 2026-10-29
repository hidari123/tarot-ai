/**
 * SSE 事件 Schema —— 前后端**单一事实源**（zod）
 *
 * ⚠️ 为什么需要这个文件：
 *   改造前，后端 `AgentEvent` 接口与前端 `switch (p.type)` 的字段名
 *   **各写一份**，中间隔着 `JSON.parse` 后的 `any`：
 *
 *     const p = JSON.parse(line.slice(5).trim());   // ← any
 *     switch (p.type) {
 *       case "card_reading": {
 *         const cr = p.cardReading;                  // ← 无类型检查
 *
 *   这已经咬过我们一次：把 `cardReading.text` 删掉时，前端漏改一处
 *   就是运行时 `undefined` 崩溃 —— **TypeScript 不会报错**，因为 p 是 any。
 *
 *   zod 方案：
 *     1. 后端 yield 前 parse 一次 → 协议写错立刻暴露（开发期）
 *     2. 前端 parse 后得到**收窄类型** → switch 有穷尽性检查
 *     3. schema 是**可执行的文档** —— 字段改了，schema 必须同步改
 *
 * ⚠️ 分两步启用（避免一次性改动过大）：
 *   阶段 1（本次）：schema 作为类型来源 + 开发期运行时校验
 *   阶段 2（后续）：把 AgentEvent 接口彻底换成 z.infer 推导
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* 基础片段                                                            */
/* ------------------------------------------------------------------ */

/** HITL 提问类型 */
export const AskKindSchema = z.enum([
  "clarify", "contract", "invocation", "card_confirm", "closing", "crossroads", "flip",
]);

/** 阶段 */
export const PhaseSchema = z.enum([
  "analyze", "retrieve", "draw", "interpret", "wait_user", "review", "done", "error",
]);

/** 牌（⚠️ 防剧透：cards 事件里 nameZh/image 为空占位） */
export const CardSchema = z.object({
  id: z.string(),
  nameZh: z.string(),
  image: z.string(),
  reversed: z.boolean(),
  pos: z.string(),
});

/** RAG 命中 */
export const RagHitSchema = z.object({
  chunkId: z.string(),
  cardId: z.string(),
  cardNameZh: z.string(),
  field: z.enum(["description", "upright", "reversed", "keywords"]),
  score: z.number(),
  snippet: z.string(),
  source: z.string(),
  channels: z.array(z.string()).optional(),
});

/** 审校结果 */
export const ReviewSchema = z.object({
  pass: z.boolean(),
  scores: z.object({
    grounding: z.number(),
    empathy: z.number(),
    tone: z.number(),
  }),
  comment: z.string().optional(),
  revision: z.string().optional(),
  rewritten: z.boolean().optional(),
  parseLevel: z.number().optional(),
  retried: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* 事件联合                                                            */
/* ------------------------------------------------------------------ */

/**
 * Agent → 前端的 SSE 事件。
 *
 * ⚠️ 用 discriminatedUnion("type") 而不是可选字段的对象 ——
 *    zod 的判别联合能推导出"按 type 分支后自动收窄 payload 类型"，
 *    这是普通 interface 做不到的。
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), sessionId: z.string() }),
  z.object({
    type: z.literal("phase"),
    phase: PhaseSchema.optional(),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal("reasoning"), reasoning: z.string() }),
  z.object({
    type: z.literal("tool"),
    tool: z.object({
      name: z.string(),
      args: z.unknown().optional(),
      resultSummary: z.string().optional(),
      durationMs: z.number().optional(),
    }),
    // 冗余通道：rag_search 的 tool 事件也内嵌 ragHits，
    // 万一独立 rag_hits 事件丢失，前端仍能渲染知识面板
    ragHits: z.array(RagHitSchema).optional(),
  }),
  z.object({ type: z.literal("rag_hits"), ragHits: z.array(RagHitSchema) }),
  z.object({ type: z.literal("cards"), cards: z.array(CardSchema) }),
  z.object({
    type: z.literal("ask_user"),
    ask: z.object({
      question: z.string(),
      options: z.array(z.string()).optional(),
      allowFree: z.boolean().optional(),
      prompt: z.string().optional(),
      kind: AskKindSchema.optional(),
    }),
    cardSelection: z.boolean().optional(),
    crossroads: z.boolean().optional(),
    fanCards: z.array(z.any()).optional(),
    fanCount: z.number().optional(),
  }),
  z.object({
    type: z.literal("subagent"),
    subagent: z.object({
      agent: z.string(),
      action: z.string(),
      detail: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("review"), review: ReviewSchema }),
  z.object({ type: z.literal("delta"), delta: z.string() }),
  z.object({
    type: z.literal("card_reveal"),
    cardReveal: z.object({
      cardIndex: z.number(),
      total: z.number(),
      id: z.string(),
      nameZh: z.string(),
      image: z.string(),
      reversed: z.boolean(),
      pos: z.string(),
      narrative: z.string(),
      meaning: z.string(),
    }),
  }),
  // ⚠️ 不带 text —— 正文只由 delta 给出（避免双数据源竞争导致重复输出）
  z.object({
    type: z.literal("card_reading"),
    cardReading: z.object({ cardIndex: z.number() }),
  }),
  // ⚠️ 刻意不含牌面（防剧透）
  z.object({
    type: z.literal("card_flip_ready"),
    cardFlipReady: z.object({
      cardIndex: z.number(),
      total: z.number(),
      pos: z.string(),
    }),
  }),
  z.object({
    type: z.literal("contract"),
    contract: z.object({ question: z.string(), scope: z.string().optional() }),
  }),
  z.object({
    type: z.literal("invocation"),
    invocation: z.object({ questions: z.array(z.string()) }),
  }),
  z.object({
    type: z.literal("round"),
    round: z.object({
      round: z.number(),
      elapsedMs: z.number(),
      promptTokens: z.number().optional(),
      toolNames: z.array(z.string()),
      phase: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("plan"), plan: z.array(z.string()) }),
  z.object({
    type: z.literal("persona_suggest"),
    personaSuggest: z.object({
      personaId: z.string(),
      name: z.string(),
      emoji: z.string(),
      reason: z.string(),
    }),
  }),
  z.object({ type: z.literal("done"), done: z.boolean().optional() }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export type AgentEventPayload = z.infer<typeof AgentEventSchema>;

/* ------------------------------------------------------------------ */
/* 运行时校验                                                          */
/* ------------------------------------------------------------------ */

/** 开发期严格校验，生产环境放行（避免每事件一次 parse 的开销） */
const STRICT = process.env.NODE_ENV !== "production";

/**
 * 后端侧：yield 前校验。
 *
 * ⚠️ 校验失败**不抛异常**（不能因为一个事件的字段写错就中断整场占卜），
 *    而是打日志并原样放行 —— 降级不删是项目底线。
 */
export function validateAgentEvent(evt: unknown): AgentEventPayload {
  if (!STRICT) return evt as AgentEventPayload;
  const parsed = AgentEventSchema.safeParse(evt);
  if (!parsed.success) {
    console.error(
      `[agent-event] schema 不匹配（type=${(evt as { type?: string })?.type}）：`,
      parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")
    );
  }
  return evt as AgentEventPayload;
}

/**
 * 前端侧：解析 SSE 事件。
 *
 * ⚠️ 解析失败**不丢弃事件** —— 返回 null 让调用方跳过这一条，
 *    不能因为一条脏数据让整场对话崩掉。
 */
export function parseAgentEvent(raw: string): AgentEventPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = AgentEventSchema.safeParse(json);
  if (!parsed.success) {
    if (STRICT) {
      console.error(
        "[agent-event] 前端收到不匹配的事件：",
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")
      );
    }
    return null;
  }
  return parsed.data;
}
