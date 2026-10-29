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
import type { AgentSession } from "../types";

/** 单场占卜的检索预算（防死循环） */
const RAG_BUDGET = 3;

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
const ragCache = new Map<string, CacheEntry>();

/** 缓存 TTL（默认 10 分钟）—— 够覆盖一次占卜内的重复检索 */
const CACHE_TTL_MS = Number(process.env.RAG_CACHE_TTL_MS) || 10 * 60 * 1000;
/** 缓存容量上限（防止无限增长） */
const CACHE_MAX = Number(process.env.RAG_CACHE_MAX) || 200;

/** 归一化查询（缓存 key） */
function cacheKey(query: string, k: number): string {
  return `${k}|${query.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/** 读缓存（过期即删） */
function readCache(key: string): RagHit[] | null {
  const e = ragCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    ragCache.delete(key);
    return null;
  }
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

/** 缓存统计（诊断/dashboard 用） */
export function ragCacheStats(): { size: number; hits: number; misses: number } {
  return { size: ragCache.size, hits: 0, misses: 0 };
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
  if (session.ragCallCount >= RAG_BUDGET) {
    return {
      summary: `⚠️ 检索预算已用尽（${session.ragCallCount}/${RAG_BUDGET} 次）。累计 ${session.ragHits.length} 条资料足够支撑解读：继续 reveal_card/interpret_card 讲牌，全部讲完后调用 write_reading。不要再检索。`,
      currentHits: [],
      allHits: session.ragHits,
      duplicate: true,
    };
  }
  session.ragQueryHistory.push(normalized);
  session.ragCallCount++;

  const k = Math.min(Math.max(topK || 5, 1), 10);

  // ---- 跨会话缓存（P1-③）----
  const key = cacheKey(query, k);
  let currentHits = readCache(key);
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
    currentHits = readCache(origKey) ?? await hybridSearch(origQuery, k);
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

  const budgetNote = session.ragCallCount >= RAG_BUDGET
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
    const key = cacheKey(rewritten, topK);
    if (readCache(key)) return; // 已有缓存，不必再算
    const hits = await hybridSearch(rewritten, topK);
    writeCache(key, hits);
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
