/**
 * RAG 检索引擎 —— BM25 + 向量混合检索（Hybrid Search, RRF 融合）+ 知识分块 + 引用溯源
 *
 * 设计目标（面试可讲）：
 * 1. 知识库 chunk 化：78 张牌 × (牌面叙事 / 正位牌意 / 逆位牌意 / 关键词) 多字段切分，
 *    每个 chunk 自带元数据（牌 id、字段类型、中文名），可溯源、可引用
 * 2. BM25（Okapi BM25）打分：经典 TF-IDF 改进版，k1=1.5 b=0.75，
 *    中文按“连续 2-gram”切词（无需分词器依赖，兼顾匹配召回与实现简洁）
 * 3. 混合检索：BM25（稀疏/字面）+ 向量（稠密/语义，transformers.js 本地推理）两路召回，
 *    RRF（Reciprocal Rank Fusion, k=60）融合排序——工业界标准做法
 * 4. 命中结果带 score / snippet / source / 命中通道，注入 prompt 的同时透出给前端做“知识面板”可视化
 */

import { TAROT_CARDS, type TarotCard } from "./tarot-cards";
import { vectorSearch } from "./vector-engine";

/* ------------------------------------------------------------------ */
/* 知识分块                                                             */
/* ------------------------------------------------------------------ */

export type ChunkField = "description" | "upright" | "reversed" | "keywords";

export interface KnowledgeChunk {
  id: string;            // chunk 唯一标识：{cardId}:{field}
  cardId: string;        // 所属牌
  cardNameZh: string;    // 牌中文名（引用展示用）
  field: ChunkField;     // 字段类型
  text: string;          // 原文
  tokens: string[];      // 预切词（2-gram）
}

const FIELD_WEIGHT: Record<ChunkField, number> = {
  description: 1.0,   // 牌面叙事
  upright: 1.2,       // 正位牌意（解读最常用）
  reversed: 1.2,      // 逆位牌意
  keywords: 1.4,      // 关键词权重最高（短而准）
};

/** 中文 2-gram 切词（无分词依赖，兼顾召回） */
export function tokenize(text: string): string[] {
  const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens: string[] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    tokens.push(clean.slice(i, i + 2));
  }
  if (clean.length === 1) tokens.push(clean);
  return tokens;
}

/** 构建全部知识块（模块加载时一次完成，~300 chunks） */
export const KNOWLEDGE_CHUNKS: KnowledgeChunk[] = TAROT_CARDS.flatMap((card) => {
  const chunks: KnowledgeChunk[] = [];
  const base = { cardId: card.id, cardNameZh: card.nameZh };
  chunks.push({
    ...base, id: `${card.id}:description`, field: "description",
    text: card.description, tokens: tokenize(`${card.nameZh} ${card.nameEn} ${card.description}`),
  });
  chunks.push({
    ...base, id: `${card.id}:upright`, field: "upright",
    text: card.upright, tokens: tokenize(`${card.nameZh} 正位 ${card.upright}`),
  });
  chunks.push({
    ...base, id: `${card.id}:reversed`, field: "reversed",
    text: card.reversed, tokens: tokenize(`${card.nameZh} 逆位 ${card.reversed}`),
  });
  chunks.push({
    ...base, id: `${card.id}:keywords`, field: "keywords",
    text: card.keywords.join("、"), tokens: tokenize(`${card.nameZh} ${card.keywords.join(" ")}`),
  });
  return chunks;
});

/* ------------------------------------------------------------------ */
/* BM25 索引                                                            */
/* ------------------------------------------------------------------ */

const K1 = 1.5;
const B = 0.75;

/** 各 token 的文档频率 DF（出现该 token 的 chunk 数） */
const DF = new Map<string, number>();
for (const chunk of KNOWLEDGE_CHUNKS) {
  const seen = new Set(chunk.tokens);
  for (const t of seen) DF.set(t, (DF.get(t) ?? 0) + 1);
}

const N = KNOWLEDGE_CHUNKS.length;
const AVG_LEN = KNOWLEDGE_CHUNKS.reduce((s, c) => s + c.tokens.length, 0) / N;

const idf = (token: string): number => {
  const df = DF.get(token) ?? 0;
  // BM25+ 式平滑，避免 df=0 时负值
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
};

/* ------------------------------------------------------------------ */
/* 检索                                                                 */
/* ------------------------------------------------------------------ */

export interface RagHit {
  chunkId: string;
  cardId: string;
  cardNameZh: string;
  field: ChunkField;
  score: number;      // 融合后归一化分数（0~1）
  rawScore: number;   // RRF 原始分
  snippet: string;    // 命中片段（截断）
  source: string;     // 引用来源描述
  channels: string[]; // 命中通道：bm25 / vector / hybrid
}

export function ragSearch(query: string, topK = 5, filterCardIds?: string[]): RagHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const qSet = new Set(qTokens);
  const pool = filterCardIds
    ? KNOWLEDGE_CHUNKS.filter((c) => filterCardIds.includes(c.cardId))
    : KNOWLEDGE_CHUNKS;

  const scored = pool.map((chunk) => {
    // 查询 token 在 chunk 中的词频
    const tfMap = new Map<string, number>();
    for (const t of chunk.tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);

    let score = 0;
    for (const t of qSet) {
      const tf = tfMap.get(t) ?? 0;
      if (tf === 0) continue;
      const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (chunk.tokens.length / AVG_LEN)));
      score += idf(t) * norm;
    }
    // 字段权重（keywords / 牌意字段加权）
    score *= FIELD_WEIGHT[chunk.field];
    return { chunk, score };
  });

  const deduped = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    // 每张牌只保留得分最高的 chunk（同一张牌的 4 个字段 chunk 都含牌名 token，
    // 不去重的话 top-k 会被同一张牌占满，看起来"检索 5 条全一样"）
    .reduce<{ hits: typeof scored; seenCards: Set<string> }>(
      (acc, s) => {
        if (acc.seenCards.has(s.chunk.cardId)) return acc;
        if (acc.hits.length >= topK) return acc;
        acc.seenCards.add(s.chunk.cardId);
        acc.hits.push(s);
        return acc;
      },
      { hits: [], seenCards: new Set<string>() }
    )
    .hits;

  if (deduped.length === 0) return [];
  // 归一化基准：top1 的原始分
  const top = deduped[0].score;
  return deduped
    .map(({ chunk, score }) => {
      return {
        chunkId: chunk.id,
        cardId: chunk.cardId,
        cardNameZh: chunk.cardNameZh,
        field: chunk.field,
        score: Math.round((score / top) * 100) / 100,
        rawScore: Math.round(score * 1000) / 1000,
        snippet: chunk.text.length > 80 ? chunk.text.slice(0, 80) + "…" : chunk.text,
        source: `tarot-lab · ${chunk.cardNameZh} · ${
          chunk.field === "description" ? "牌面叙事" : chunk.field === "upright" ? "正位牌意" : chunk.field === "reversed" ? "逆位牌意" : "关键词"
        }`,
        channels: ["bm25"],
      } satisfies RagHit;
    });
}

/* ------------------------------------------------------------------ */
/* 牌名精确通道（第三通道：结构化精确匹配）                              */
/* ------------------------------------------------------------------ */

/**
 * 从查询中抽取显式提到的牌名。
 *
 * 为什么需要：BM25 是 2-gram 字面匹配，"宝剑十"会命中"权杖十""星币十"
 * （共享"剑十/杖十/币十"里的"X十" gram，且"十"字 IDF 极低）——
 * top-5 里 4 条是无关牌，真正要查的牌只占 1 条。
 * 牌名是封闭词表（78 张，全量已知），精确匹配零歧义，
 * 这正是"结构化字段走精确通道、自由文本走模糊通道"的生产 RAG 分层。
 */
const CARD_NAME_INDEX: Array<{ names: string[]; cardId: string }> = TAROT_CARDS.map((c) => ({
  names: [c.nameZh, c.nameEn],
  cardId: c.id,
}));

/** 返回查询中显式提到的牌 id（含别名命中） */
export function extractMentionedCards(query: string): string[] {
  const found: string[] = [];
  for (const { names, cardId } of CARD_NAME_INDEX) {
    if (names.some((n) => n && query.includes(n))) found.push(cardId);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* 混合检索（Hybrid）：精确 + BM25 + 向量，RRF 融合                       */
/* ------------------------------------------------------------------ */

const RRF_K = 60; // Reciprocal Rank Fusion 常数

/** 精确通道命中（查询显式提到的牌，取正位/逆位/关键词 3 个最常用字段，通道标记 exact） */
function exactCardHits(cardIds: string[]): RagHit[] {
  // 只取解读最常用的 3 个字段：正位 / 逆位 / 关键词
  // （叙事字段太长，LLM 回填的压缩片段放不下；且 4 字段全进池会挤占其他语义相关牌的名额）
  const WANTED: ChunkField[] = ["upright", "reversed", "keywords"];
  const hits: RagHit[] = [];
  for (const cid of cardIds) {
    for (const chunk of KNOWLEDGE_CHUNKS) {
      if (chunk.cardId !== cid || !WANTED.includes(chunk.field)) continue;
      hits.push({
        chunkId: chunk.id,
        cardId: chunk.cardId,
        cardNameZh: chunk.cardNameZh,
        field: chunk.field,
        score: 1,
        rawScore: 1,
        snippet: chunk.text.length > 80 ? chunk.text.slice(0, 80) + "…" : chunk.text,
        source: `tarot-lab · ${chunk.cardNameZh} · ${
          chunk.field === "description" ? "牌面叙事" : chunk.field === "upright" ? "正位牌意" : chunk.field === "reversed" ? "逆位牌意" : "关键词"
        }`,
        channels: ["exact"],
      });
    }
  }
  return hits;
}

/**
 * 混合检索入口（Agent 的 rag_search 工具实际调用这里）
 * 三路召回：牌名精确 → BM25 → 向量 → RRF 融合 → 每牌去重 → 归一化返回
 *
 * 精确通道的意义：显式提到的牌必进 top-k 且置顶（RRF 里 3 通道同时命中排名最高），
 * 彻底解决"查宝剑十返回权杖十/星币十"的字面污染问题。
 */
export async function hybridSearch(query: string, topK = 5): Promise<RagHit[]> {
  // 向量通道软超时：无论模型加载/嵌入多慢，最多等 8 秒，超时按无命中处理（纯 BM25 兜底）
  const VECTOR_SOFT_TIMEOUT_MS = 8_000;
  const vecWithTimeout = Promise.race([
    vectorSearch(query, topK * 2),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), VECTOR_SOFT_TIMEOUT_MS)),
  ]).catch(() => null);

  // 牌名精确通道（同步、零成本）
  const mentioned = extractMentionedCards(query);
  const exactHits = exactCardHits(mentioned);

  // 两路并行召回（各多取一些，融合后截断）
  const [bm25Hits, vecHits] = await Promise.all([
    Promise.resolve(ragSearch(query, topK * 2)),
    vecWithTimeout,
  ]);

  if (exactHits.length === 0 && bm25Hits.length === 0 && (!vecHits || vecHits.length === 0)) return [];
  // 向量通道不可用（未装模型/降级/软超时）→ 精确 + BM25
  if (!vecHits || vecHits.length === 0) {
    return fuseAndDedup(exactHits, ragSearch(query, topK), [], topK);
  }

  // 向量命中转为通用 RagHit 形状（补齐 rawScore/source/channels）
  const vecAsRag: RagHit[] = vecHits.map((v) => ({
    chunkId: v.chunkId,
    cardId: v.cardId,
    cardNameZh: v.cardNameZh,
    field: v.field,
    score: v.score,
    rawScore: v.score,
    snippet: v.snippet,
    source: `tarot-lab · ${v.cardNameZh} · ${
      v.field === "description" ? "牌面叙事" : v.field === "upright" ? "正位牌意" : v.field === "reversed" ? "逆位牌意" : "关键词"
    }`,
    channels: ["vector"],
  }));

  return fuseAndDedup(exactHits, bm25Hits, vecAsRag, topK);
}

/** RRF 融合 + 每牌去重 + 归一化（三通道通用） */
function fuseAndDedup(exactHits: RagHit[], bm25Hits: RagHit[], vecHits: RagHit[], topK: number): RagHit[] {
  // 无精确命中时退化为原两路
  if (exactHits.length === 0 && bm25Hits.length === 0 && vecHits.length === 0) return [];

  // RRF 融合：score = Σ 1/(k + rank)；同一 chunk 多通道命中排名叠加
  const fused = new Map<string, RagHit & { rrf: number; chans: Set<string> }>();
  const addRank = (hits: RagHit[], channel: string) => {
    hits.forEach((h, idx) => {
      const rrf = 1 / (RRF_K + idx + 1);
      const prev = fused.get(h.chunkId);
      if (prev) {
        prev.rrf += rrf;
        prev.chans.add(channel);
        // 保留更长 snippet
        if (h.snippet.length > prev.snippet.length) prev.snippet = h.snippet;
      } else {
        fused.set(h.chunkId, { ...h, rrf, chans: new Set([channel]) });
      }
    });
  };
  // 精确通道优先加入（排名最靠前），再 BM25、向量
  addRank(exactHits, "exact");
  addRank(bm25Hits, "bm25");
  addRank(vecHits, "vector");

  // 融合排序 → 每牌去重 → top-k
  const sorted = [...fused.values()].sort((a, b) => b.rrf - a.rrf);
  const seenCards = new Set<string>();
  const out: RagHit[] = [];
  for (const h of sorted) {
    if (seenCards.has(h.cardId)) continue;
    if (out.length >= topK) break;
    seenCards.add(h.cardId);
    out.push({
      chunkId: h.chunkId,
      cardId: h.cardId,
      cardNameZh: h.cardNameZh,
      field: h.field,
      score: Math.round((h.rrf / (sorted[0].rrf || 1)) * 100) / 100,
      rawScore: Math.round(h.rrf * 10000) / 10000,
      snippet: h.snippet,
      source: h.source,
      channels: [...h.chans],
    });
  }
  return out;
}

/** 把命中结果组装为注入 prompt 的知识上下文（含引用编号） */
export function buildPromptContext(hits: RagHit[]): string {
  if (hits.length === 0) return "（知识库未检索到直接相关内容）";
  return hits
    .map((h, i) => `[${i + 1}] ${h.source}\n    ${h.snippet}`)
    .join("\n");
}

/** 牌面完整知识（抽到的牌：叙事+正逆位+关键词，供解读引用） */
export function buildCardKnowledge(cards: { card: TarotCard; reversed: boolean }[]): string {
  const posNames = ["过去", "当下", "未来"];
  return cards
    .map(({ card, reversed }, i) => {
      const pos = posNames[i] ?? `牌${i + 1}`;
      return (
        `【${pos} · ${card.nameZh}（${card.nameEn}）${reversed ? "逆位" : "正位"}】\n` +
        `  元素：${card.element}\n` +
        `  牌面叙事：${card.description}\n` +
        `  典籍牌意：${reversed ? card.reversed : card.upright}\n` +
        `  关键词：${card.keywords.join("、")}`
      );
    })
    .join("\n\n");
}
