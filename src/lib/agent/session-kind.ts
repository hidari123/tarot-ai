/**
 * 会话种类 —— 占卜 / 神谕（2026-11-04 D 方向）
 *
 * ⚠️⚠️ 为什么**不**新写一个"神谕专用 Agent"：
 *   那会导致两套 prompt、两套 RAG 配置、两套质量标准、两套 bug ——
 *   而且两套会慢慢漂移（改了占卜忘了神谕）。
 *   → 神谕与占卜**共用同一个 runAgent**，只是：
 *     ① system prompt 不同（塔罗向导 vs 占卜师）
 *     ② 可用工具集不同（神谕没有抽牌类工具）
 *     ③ 阶段推进不同（神谕不走仪式状态机）
 *   其余（RAG / 人格 / 记忆 / 追问 / 情绪档案 / 审校）**完全复用**。
 *
 * ⚠️ 竞品对标（Tarot Run 的 Oracle）：
 *   「無論是剛抽到的牌、看不懂的牌陣，還是想理清的處境，都可以直接提問」
 *   「可以追問 —— 一次解讀往往不夠。神諭會記住上下文」
 *   「幫你挑選牌陣 —— 描述你的問題，神諭會推薦合適的牌陣」
 *   「用哪種語言提問，就用哪種語言回答」
 */

export type SessionKind = "divination" | "oracle";

/** 默认（占卜） */
export const DEFAULT_KIND: SessionKind = "divination";

/**
 * 宽容解析（kind 来自 HTTP body，客户端可控）
 */
export function resolveKind(raw: unknown): SessionKind {
  if (raw === "oracle" || raw === "divination") return raw;
  return DEFAULT_KIND;
}

/** 是否神谕 */
export function isOracle(kind: SessionKind | undefined): boolean {
  return kind === "oracle";
}
