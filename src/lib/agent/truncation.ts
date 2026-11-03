/**
 * 输出截断标记（P3-⑩）
 *
 * ⚠️ 为什么要单独一个模块（而不是放在 session.ts）：
 *   llm.ts（标记）→ session.ts（存 session）→ agent/index.ts → llm.ts
 *   会形成**循环导入**。单独一个模块切断依赖环：
 *     llm.ts → truncation.ts（写）
 *     subagents.ts → truncation.ts（读）
 *
 * ⚠️ 为什么这个标记重要（"假绿灯"的根源）：
 *   流式调用中断时，已经输出给用户的正文是**不完整**的。
 *   如果不显式标记：
 *     reviewer 会基于半截正文打分 → `pass: true` 落库
 *     → dashboard 的"审校通过率"是**伪影** → 掩盖真实的质量问题。
 *   这正是项目里"指标本身要被验证"那条教训的又一个实例：
 *   一个没被标记的异常状态，会让所有下游指标看起来正常。
 */

import { runtimeState } from "../runtime";

/** 被截断的会话 id 集合 */
const truncatedSessions = runtimeState<Set<string>>(
  "llm.truncatedSessions",
  () => new Set<string>()
);

/**
 * 标记某场占卜的输出被截断
 *
 * @param sessionId 会话 id（null 表示没有会话上下文 → 忽略）
 */
export function markTruncated(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  truncatedSessions.add(sessionId);
}

/**
 * 判断某场占卜的输出是否被截断
 */
export function isTruncated(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return truncatedSessions.has(sessionId);
}

/**
 * 清除标记（一场占卜结束时调用，避免集合无限增长）
 */
export function clearTruncated(sessionId: string): void {
  truncatedSessions.delete(sessionId);
}

/** 当前被标记的会话数（诊断用） */
export function truncatedCount(): number {
  return truncatedSessions.size;
}
