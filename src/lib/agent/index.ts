/**
 * Agent 引擎 —— 统一出口
 *
 * ⚠️ 为什么有这一层：
 *    拆包后代码分散在 8 个文件里，但**外部调用方不应该知道**。
 *    本文件 re-export 全部公共 API —— 现有
 *    `import { runAgent, getSession } from "@/lib/tarot-agent"`
 *    的调用方（4 个 API 路由）**零改动**。
 *
 * 拆包后的模块地图：
 *   types.ts        共享类型（AgentEvent / AgentSession / AskKind …）
 *   session.ts      会话生命周期（创建/获取/TTL/快照恢复）
 *   hitl.ts         HITL 等待（唯一阻塞点 · 超时哨兵）
 *   llm.ts          LLM 调用（failover + 熔断器）
 *   helpers.ts      辅助函数（情绪/分支/上下文压缩/牌槽）
 *   subagents.ts    子 Agent 管线（analyst → writer → reviewer）
 *   tools/          工具（定义 + 执行器）
 *   supervisor.ts   主循环（编排中枢）
 *   fallback.ts     无 Key 降级（剧本式本地模拟）
 */

export type {
  AgentEvent,
  AgentSession,
  AskKind,
  DrawnCard,
  SessionMessage,
  SubAgent,
} from "./types";

/* 内部使用（本文件底部的兼容层函数需要） */
import { getSession } from "./session";

export {
  createSession,
  getSession,
  listSessions,
  cleanExpired,
  snapshotSession,
  restoreSession,
  markSessionDirty,
  persistDirtySessions,
  type SessionSnapshot,
} from "./session";
export { waitUserAnswer, isHitlGone } from "./hitl";

export { splitThinkTags, callLLM, streamLLM, breaker, CircuitBreaker } from "./llm";
export type { CallResult } from "./llm";

export { runAgent } from "./supervisor";
export { runLocalFallback } from "./fallback";

export { execRagSearch, prefetchForCard, clearRagCache, ragCacheStats } from "./tools/rag";
export { execDrawCards, buildFanCards, applyFanSelection } from "./tools/cards";
export { TOOLS } from "./tools/definitions";

export { runAnalyst, runWriter, runReviewer } from "./subagents";
export type { ReviewResult } from "./subagents";

export {
  extractEmotionTags,
  suggestPersonaByEmotion,
  extractBranchesFromPrompt,
  buildFinalReading,
  ensureCardSlot,
  compressRagResult,
  trimHistory,
} from "./helpers";

/* ------------------------------------------------------------------ */
/* 兼容层：会话相关的小工具（原在 tarot-agent.ts 里）                    */
/* ------------------------------------------------------------------ */

/**
 * 回答当前挂起的 HITL 问题。
 *
 * ⚠️ 同一时刻只能有一个 pendingAsk —— 返回 false 表示
 *    "当前没有等待回答的问题"（前端据此提示 409）。
 */
export function resolvePendingAsk(sessionId: string, answer: string): boolean {
  const s = getSession(sessionId);
  if (!s?.pendingAsk) return false;
  s.pendingAsk.resolve(answer);
  s.pendingAsk = undefined;
  return true;
}

/**
 * 追加用户插话（方案 C）。
 *
 * 与 resolvePendingAsk 的区别：
 *   - resolvePendingAsk：回答**当前正在等**的问题（唤醒挂起的 Promise）
 *   - appendInterjection：用户主动补充信息，**不唤醒**任何等待，
 *     只把内容追加进会话历史，让接下来的解读能看到。
 *
 * 真实场景：用户在看第 1 张牌的解读时插一句"其实我不是不甘心，是怕又白投"，
 * 占卜师在讲第 2 张牌时就能用上这条信息。
 */
export function appendInterjection(sessionId: string, text: string): boolean {
  const s = getSession(sessionId);
  if (!s) return false;
  const t = text.trim();
  if (!t) return false;
  s.interjections.push(t);
  // ⚠️ 插话位置很关键：assistant 消息里的 tool_calls 必须紧跟对应的 tool 消息，
  // 否则 OpenAI 兼容协议错位（"tool call result does not follow tool call"）。
  // 因此只有当最后一条消息是 tool（或 user/assistant 且无 tool_calls）时才插。
  const last = s.messages[s.messages.length - 1];
  const safeToInsert =
    !last ||
    last.role === "tool" ||
    (last.role === "assistant" && !last.tool_calls?.length);
  if (safeToInsert) {
    s.messages.push({ role: "user", content: `（用户补充说明：${t}）` });
  } else {
    // 不安全位置：暂存，等下一轮开始时由 flush 逻辑插入
    s.pendingInterjections.push(t);
  }
  return true;
}

export { getCardById, TAROT_CARDS } from "../tarot-cards";
