/**
 * RAG 检索工具 —— 执行器 + 查询缓存 + 预算控制
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 *
 * ⚠️ 三个防御层（缺一不可，实测踩过坑）：
 *   1. 重复检索负反馈 —— 模型会换词重试同一件事，实测同一查询重复 5 次
 *   2. 预算硬拦截 —— 光靠查重拦不住"每次换个词"的绕路
 *   3. 零命中回退 —— 改写可能跑偏，用原查询再试一次
 *
 * P1-③ 新增：**跨会话查询缓存**（同一查询只检索一次）
 */

import * as db from "../../db";
import { hybridSearch, type RagHit } from "../../rag-engine";
import { rewriteQueryLocal } from "../../query-rewrite";
import { TAROT_CARDS } from "../../tarot-cards";
import { runtimeState } from "../../runtime";
import type { AgentSession } from "../types";

/** 单场占卜的检索预算（防死循环） */
const RAG_BUDGET = 3;

/**
 * 该会话的检索预算（按模式）
 *
 * ⚠️ 2026-11-04 双模式：快速模式的预算是 2（深度模式仍是 3）。
 *
 * ⚠️ 实测踩到的坑：快速模式第一次跑出时，工具序列是
 *   rag_search ×3 + reveal_card ×3 + interpret_card ×1
 *   → 共 11 轮 → **撞了 max_rounds**。
 *   根因之一就是检索用了 3 次（模型一张牌查一次）。
 * ⚠️ 修法：
 *   · 预算降到 2（省 1 轮）
 *   · system prompt 明确要求"一次 rag_search 查所有牌"（省 2 轮）
 *   → 两者叠加，快速模式的检索从 3 轮降到 1 轮。
 */
export function ragBudgetFor(session: { mode?: string }): number {
  return session.mode === "quick" ? 2 : RAG_BUDGET;
}

/* ------------------------------------------------------------------ */
/* 跨会话查询缓存（P1-③）                                              */
/* ------------------------------------------------------------------ */

/**
 * 查询缓存 —— 同一查询在 TTL 内只检索一次。
 *
 * ⚠️ 为什么需要：
 *   知识库是**静态**的（78 张牌的典籍，不会变）。同一个查询
 *   （"权杖七"）在不同会话里检索结果完全一样 —— 每次重算纯属浪费。
 *   命中缓存时省掉整个 BM25 + 向量检索（~100~400ms，含 ONNX 推理）。
 *
 * ⚠️ 缓存 key 必须归一化（去空格+小写+去标点），
 *   否则 "权杖七" 与 "权杖七 " 是两个 key。
 */
interface CacheEntry {
  hits: RagHit[];
  at: number;
}
/**
 * 检索缓存
 *
 * ⚠️ P1-⑥：挂到 globalThis —— 原来这里是**模块级** Map，
 *    HMR 重载会清空 → 缓存命中率统计归零（指标失真）+
 *    每次热重载后都要重算一次向量检索。
 */
const ragCache = runtimeState<Map<string, CacheEntry>>(
  "rag.cache",
  () => new Map<string, CacheEntry>()
);

/** 缓存 TTL（默认 10 分钟）—— 够覆盖一次占卜内的重复检索 */
const CACHE_TTL_MS = Number(process.env.RAG_CACHE_TTL_MS) || 10 * 60 * 1000;
/** 缓存容量上限（防止无限增长） */
const CACHE_MAX = Number(process.env.RAG_CACHE_MAX) || 200;

/**
 * 归一化查询（缓存 key）
 *
 * ⚠️ P2-⑧（第二轮优化分析 2026-11 ⑧）：key 里带 top_k 是**设计缺陷**。
 *   实测：预取写的是 `5|权杖七`，模型实际检索用的是 `10|权杖七 复合 前任`
 *   —— **query 和 top_k 都不匹配** → 预取命中率 **0%**（实测 0/60）。
 * ⚠️ 但 key 里去掉 top_k 也不对：不同 top_k 的结果集不同（k=5 是 k=10 的子集）。
 *   → 修法见 `readCacheFlexible`：命中时按请求的 k **裁剪**结果。
 */
function cacheKey(query: string, k: number): string {
  return `${k}|${query.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/**
 * 查缓存（**允许 top_k 降级命中**）—— P2-⑧ 的核心修复。
 *
 * ⚠️ 为什么需要：
 *   预取用牌名（"权杖七"）、用 k=5；模型检索用改写后的长 query、用 k=10。
 *   两者**永远不可能**命中同一个 key —— 实测命中率 0%。
 *   但预取的**内容**是有效的：它检索的就是这张牌的知识。
 *
 * ⚠️ 修法（两层）：
 *   ① **牌名子串匹配**：如果请求的 query 里**包含**某个已缓存条目的牌名，
 *      就把那个缓存条目当作候选（裁剪到请求的 k）。
 *   ② **同 query 不同 k**：同一条 query 用不同 top_k 存过 → 取更大的那份再裁剪。
 *
 * ⚠️ 语义说明：命中的是"同一张牌的知识"，**内容等价**（知识库按牌切分），
 *   只是 query 表述不同 —— 这正是预取的设计意图。
 */
function readCacheFlexible(query: string, k: number): RagHit[] | null {
  // ① 直接命中
  const direct = readCache(cacheKey(query, k));
  if (direct) return direct;

  // ② 同一 query、不同 top_k → 取最大的那份再裁剪
  const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
  const prefix = `${normalized}`;
  let best: RagHit[] | null = null;
  for (const [key, entry] of ragCache) {
    if (Date.now() - entry.at > CACHE_TTL_MS) continue;
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    if (key.slice(sep + 1) !== prefix) continue;
    if (!best || entry.hits.length > best.length) best = entry.hits;
  }
  if (best && best.length > 0) {
    const sliced = best.slice(0, k);
    cacheCounters.hits++;
    return sliced;
  }

  // ③ 牌名子串匹配：query 里包含某个已缓存条目的牌名
  //    （预取存的是"权杖七"，模型检索是"权杖七 复合 前任" → 命中）
  for (const [key, entry] of ragCache) {
    if (Date.now() - entry.at > CACHE_TTL_MS) continue;
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const cachedQuery = key.slice(sep + 1);
    if (!cachedQuery || cachedQuery.length < 2) continue;
    if (!normalized.includes(cachedQuery)) continue;
    // ⚠️ 命中：取该条缓存里属于这张牌的结果，裁剪到 k
    const sliced = entry.hits.slice(0, k);
    if (sliced.length > 0) {
      cacheCounters.hits++;
      return sliced;
    }
  }
  return null;
}

/**
 * 缓存命中/未命中计数（P3-⑩）
 *
 * ⚠️ 为什么必须真实计数（原来恒返回 0）：
 *    审计实测：ragCacheStats() 永远返回 `{hits: 0, misses: 0}`。
 *    这不只是"少个数字"—— 它是**误导性**的：
 *    如果有人用它验证"跨会话缓存是否生效"，会得到"命中率 0%"
 *    → **错误地否决掉 P1-③ 这个优化**。
 *    指标本身坏了，比没有指标更危险。
 */
const cacheCounters = runtimeState<{ hits: number; misses: number }>(
  "rag.cacheCounters",
  () => ({ hits: 0, misses: 0 })
);

/** 读缓存（过期即删） */
function readCache(key: string): RagHit[] | null {
  const e = ragCache.get(key);
  if (!e) {
    cacheCounters.misses++;
    return null;
  }
  if (Date.now() - e.at > CACHE_TTL_MS) {
    ragCache.delete(key);
    cacheCounters.misses++;
    return null;
  }
  cacheCounters.hits++;
  return e.hits;
}

/** 写缓存（超容量时淘汰最旧的） */
function writeCache(key: string, hits: RagHit[]): void {
  if (ragCache.size >= CACHE_MAX) {
    // 淘汰最旧的一条（FIFO —— Map 保持插入序）
    const oldest = ragCache.keys().next();
    if (!oldest.done) ragCache.delete(oldest.value);
  }
  ragCache.set(key, { hits, at: Date.now() });
}

/**
 * 缓存统计（诊断/dashboard 用）
 *
 * ⚠️ P3-⑩：现在是**真实**计数（原来恒返回 0）。
 */
export function ragCacheStats(): {
  size: number; hits: number; misses: number; hitRate: number;
} {
  const { hits, misses } = cacheCounters;
  const total = hits + misses;
  return {
    size: ragCache.size,
    hits,
    misses,
    hitRate: total > 0 ? Math.round((hits / total) * 100) : 0,
  };
}

/** 清空缓存（测试用） */
export function clearRagCache(): void {
  ragCache.clear();
}

/* ------------------------------------------------------------------ */
/* 检索执行器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 执行一次检索。
 *
 * @param origQuery 改写前的用户原始查询（零命中时回退重试用）
 */
export async function execRagSearch(
  query: string,
  topK: number,
  session: AgentSession,
  origQuery?: string
): Promise<{
  summary: string;
  currentHits: RagHit[];
  allHits: RagHit[];
  duplicate: boolean;
}> {
  // ---- 重复检索负反馈（防死循环的关键）----
  // 归一化查询（去空格+小写）后与历史比对；重复查询直接返回"已检索过"标记，
  // 模型收到显式负反馈就不会再撞同一面墙（实测：max_rounds 会话里同一查询重复了 5 次）
  const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (session.ragQueryHistory.includes(normalized)) {
    return {
      summary: `⚠️ 该查询「${query.slice(0, 20)}」此前已检索过（内容见上文，无需重复）。信息已足够，请立即调用 write_reading 开始解读。`,
      currentHits: [],
      allHits: session.ragHits,
      duplicate: true,
    };
  }
  // ---- 预算硬拦截（超预算后不再放行新查询，防"换词重试"绕过查重）----
  // 实测：money 用例连续 12 轮 rag_search，每次换个查询词，查重拦不住。
  // 超预算后一律返回负反馈（不管牌是否讲完——检索预算与翻牌进度无关）。
  // ⚠️ 2026-11-04 双模式：预算按模式（快速模式 2 次，深度模式 3 次）
  const budget = ragBudgetFor(session);
  if (session.ragCallCount >= budget) {
    return {
      summary: `⚠️ 检索预算已用尽（${session.ragCallCount}/${budget} 次）。累计 ${session.ragHits.length} 条资料足够支撑解读：继续 reveal_card/interpret_card 讲牌，全部讲完后调用 write_reading。不要再检索。`,
      currentHits: [],
      allHits: session.ragHits,
      duplicate: true,
    };
  }
  session.ragQueryHistory.push(normalized);
  session.ragCallCount++;

  const k = Math.min(Math.max(topK || 5, 1), 10);

  // ---- 跨会话缓存（P1-③）----
  // ⚠️ P2-⑧：用**柔性查找**（允许 top_k 降级 + 牌名子串匹配）——
  //    原来的精确 key 查找让预取命中率实测 0%（0/60）。
  const key = cacheKey(query, k);
  let currentHits = readCacheFlexible(query, k);
  let fromCache = false;
  if (currentHits) {
    fromCache = true;
  } else {
    currentHits = await hybridSearch(query, k);
    writeCache(key, currentHits);
  }

  // 零命中自评估重试——改写后的查询反而零命中时（词典改写可能跑偏），
  // 用原始查询再试一次。两轮都空才算真的没资料（宁可多一次检索也不让
  // 解读"无典籍依据"——引文闭环是本项目的核心展示点）。
  if (currentHits.length === 0 && origQuery && query !== origQuery) {
    try { db.logTiming(session.id, "rag_zero_retry", 0, `改写「${origQuery.slice(0, 16)}」零命中，回退原查询`); } catch { /* ignore */ }
    const origKey = cacheKey(origQuery, k);
    currentHits = readCacheFlexible(origQuery, k) ?? await hybridSearch(origQuery, k);
    writeCache(origKey, currentHits);
  }

  // ⚠️ 累积而非覆盖：supervisor 一场占卜常检索多次（每张牌一次），
  // 覆盖会导致解读里的 [n] 编号对应不上知识面板（引文闭环断裂）。
  // 按 chunkId 去重合并，编号即检索顺序，知识面板与 [n] 永远一致。
  const seen = new Set(session.ragHits.map((h) => h.chunkId));
  for (const h of currentHits) {
    if (!seen.has(h.chunkId)) {
      session.ragHits.push(h);
      seen.add(h.chunkId);
    }
  }

  const budgetNote = session.ragCallCount >= ragBudgetFor(session)
    ? "（已达检索预算上限，请立即 write_reading）"
    : "";
  const zeroNote = currentHits.length === 0
    ? "（两轮查询均零命中——该主题典籍暂缺，请直接基于牌意知识解读，不要再次检索）"
    : "";
  const cacheNote = fromCache ? "（缓存命中）" : "";
  const summary = `检索到 ${currentHits.length} 条：${currentHits.slice(0, 3).map((h) => `${h.cardNameZh}(${h.score},${h.channels.join("+")})`).join("、")}${currentHits.length > 3 ? "…" : ""}（累计 ${session.ragHits.length} 条）${cacheNote}${budgetNote}${zeroNote}`;
  return { summary, currentHits, allHits: session.ragHits, duplicate: false };
}

/**
 * 投机预检索（翻牌瞬间触发）—— 用户点开这张牌的瞬间，牌名已知，
 * 提前触发检索（fire-and-forget），结果进**跨会话缓存**。
 *
 * ⚠️ P1-③ 改进点：
 *   旧实现把结果写进 session.ragHits（会话级），但下一轮模型调
 *   rag_search 时用的是**改写后的查询**（可能与预检索的查询串不同）→
 *   查重命中不了 → 预检索白做。
 *   现在改为写入**归一化后的跨会话缓存**：下一轮无论用什么查询串，
 *   只要归一化后一致就能命中缓存。
 *
 *   同时把 Promise 返回给调用方 —— 调用方可以在"该等"的时机 await
 *   它（如念牌前），把检索延迟完全藏进模型思考时间里。
 */
export async function prefetchForCard(
  cardNameZh: string,
  session: AgentSession,
  topK = 5
): Promise<void> {
  try {
    const rewritten = rewriteQueryLocal(cardNameZh, TAROT_CARDS.map((c) => c.nameZh));
    // ⚠️ P2-⑧：按**多个 top_k** 各存一份。
    //   实测模型实际传的 top_k 分布里 **10 占 55.8%**、5 占 30% 左右 ——
    //   预取只存 k=5 的话，模型用 k=10 时依然要重算。
    //   存两份的代价 = 一次额外的向量检索（~100~400ms），
    //   但**省掉**的是后续那次完整检索 —— 净收益为正。
    const ks = Array.from(new Set([topK, 5, 10]));
    let hits: RagHit[] | null = null;
    for (const k of ks) {
      const key = cacheKey(rewritten, k);
      const cached = readCache(key);
      if (cached && cached.length > 0) {
        hits = cached;
        continue; // 这一档已有缓存
      }
      if (!hits) {
        // ⚠️ 只真正检索一次（用最小的 k），其它档位从这份结果切出来
        const computed = await hybridSearch(rewritten, Math.max(...ks));
        hits = computed;
        for (const k2 of ks) writeCache(cacheKey(rewritten, k2), computed.slice(0, k2));
        break;
      }
    }
    if (!hits || hits.length === 0) return;
    // ⚠️ 同时把命中写进 session.ragHits —— 保证本场的 [n] 编号连续
    //    （引文闭环：知识面板的编号必须与正文里的 [n] 一致）。
    //    去重按 chunkId，与 execRagSearch 的逻辑一致。
    const seen = new Set(session.ragHits.map((h) => h.chunkId));
    for (const h of hits) {
      if (!seen.has(h.chunkId)) {
        session.ragHits.push(h);
        seen.add(h.chunkId);
      }
    }
  } catch {
    /* 预检索失败不影响主线 */
  }
}

export { RAG_BUDGET };
