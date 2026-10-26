/**
 * MCP Server 用的 BM25 检索（从 rag-engine 移植核心逻辑，无 TS alias）
 * 同步说明：src/lib/rag-engine.ts 增加"牌名精确通道"后，这里同步精确匹配逻辑
 * （MCP 的 tarot_search 工具同样受益：查"宝剑十"不再被"权杖十/星币十"污染）
 */

const { TAROT_CARDS } = require("./tarot-cards.cjs");

function tokenize(text) {
  const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
  const tokens = [];
  for (let i = 0; i < clean.length - 1; i++) tokens.push(clean.slice(i, i + 2));
  if (clean.length === 1) tokens.push(clean);
  return tokens;
}

const FIELD_WEIGHT = { description: 1.0, upright: 1.2, reversed: 1.2, keywords: 1.4 };

const KNOWLEDGE_CHUNKS = TAROT_CARDS.flatMap((card) => {
  const base = { cardId: card.id, cardNameZh: card.nameZh };
  return [
    { ...base, id: `${card.id}:description`, field: "description", text: card.description, tokens: tokenize(`${card.nameZh} ${card.nameEn} ${card.description}`) },
    { ...base, id: `${card.id}:upright`, field: "upright", text: card.upright, tokens: tokenize(`${card.nameZh} 正位 ${card.upright}`) },
    { ...base, id: `${card.id}:reversed`, field: "reversed", text: card.reversed, tokens: tokenize(`${card.nameZh} 逆位 ${card.reversed}`) },
    { ...base, id: `${card.id}:keywords`, field: "keywords", text: card.keywords.join("、"), tokens: tokenize(`${card.nameZh} ${card.keywords.join(" ")}`) },
  ];
});

const K1 = 1.5, B = 0.75;
const DF = new Map();
for (const chunk of KNOWLEDGE_CHUNKS) {
  const seen = new Set(chunk.tokens);
  for (const t of seen) DF.set(t, (DF.get(t) ?? 0) + 1);
}
const N = KNOWLEDGE_CHUNKS.length;
const AVG_LEN = KNOWLEDGE_CHUNKS.reduce((s, c) => s + c.tokens.length, 0) / N;

function idf(token) {
  const df = DF.get(token) ?? 0;
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/* ---- 牌名精确通道（与 src/lib/rag-engine.ts 同步）---- */

const CARD_NAME_INDEX = TAROT_CARDS.map((c) => ({ names: [c.nameZh, c.nameEn], cardId: c.id }));

function extractMentionedCards(query) {
  const found = [];
  for (const { names, cardId } of CARD_NAME_INDEX) {
    if (names.some((n) => n && query.includes(n))) found.push(cardId);
  }
  return found;
}

/** 精确通道命中：显式提到的牌取正位/逆位/关键词 3 字段置顶 */
function exactCardHits(cardIds) {
  const WANTED = ["upright", "reversed", "keywords"];
  const hits = [];
  for (const cid of cardIds) {
    for (const chunk of KNOWLEDGE_CHUNKS) {
      if (chunk.cardId !== cid || !WANTED.includes(chunk.field)) continue;
      hits.push({
        chunkId: chunk.id, cardId: chunk.cardId, cardNameZh: chunk.cardNameZh, field: chunk.field,
        score: 1,
        snippet: chunk.text.length > 80 ? chunk.text.slice(0, 80) + "…" : chunk.text,
        source: `tarot-lab · ${chunk.cardNameZh} · ${chunk.field === "upright" ? "正位牌意" : chunk.field === "reversed" ? "逆位牌意" : "关键词"}`,
        channels: ["exact"],
      });
    }
  }
  return hits;
}

/** 检索入口：精确通道置顶 + BM25 语义补充（MCP 环境无向量模型，纯同步） */
function ragSearch(query, topK = 5) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const exact = exactCardHits(extractMentionedCards(query));

  const qSet = new Set(qTokens);

  const scored = KNOWLEDGE_CHUNKS.map((chunk) => {
    const tfMap = new Map();
    for (const t of chunk.tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of qSet) {
      const tf = tfMap.get(t) ?? 0;
      if (tf === 0) continue;
      const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (chunk.tokens.length / AVG_LEN)));
      score += idf(t) * norm;
    }
    score *= FIELD_WEIGHT[chunk.field];
    return { chunk, score };
  });

  const deduped = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .reduce((acc, s) => {
      if (acc.seen.has(s.chunk.cardId) || acc.hits.length >= topK) return acc;
      acc.seen.add(s.chunk.cardId);
      acc.hits.push(s);
      return acc;
    }, { hits: [], seen: new Set() })
    .hits;

  // 融合：精确命中的牌置顶（去重），BM25 结果补位
  const out = [];
  const seen = new Set();
  for (const h of exact) {
    if (seen.has(h.cardId) || out.length >= topK) continue;
    seen.add(h.cardId);
    out.push(h);
  }
  for (const s of deduped) {
    if (seen.has(s.chunk.cardId) || out.length >= topK) continue;
    seen.add(s.chunk.cardId);
    const chunk = s.chunk;
    out.push({
      chunkId: chunk.id, cardId: chunk.cardId, cardNameZh: chunk.cardNameZh, field: chunk.field,
      score: Math.round((s.score / (deduped[0].score || 1)) * 100) / 100,
      snippet: chunk.text.length > 80 ? chunk.text.slice(0, 80) + "…" : chunk.text,
      source: `tarot-lab · ${chunk.cardNameZh} · ${chunk.field === "description" ? "牌面叙事" : chunk.field === "upright" ? "正位牌意" : chunk.field === "reversed" ? "逆位牌意" : "关键词"}`,
      channels: ["bm25"],
    });
  }
  if (out.length === 0) return [];
  return out;
}

module.exports = { ragSearch, KNOWLEDGE_CHUNKS, extractMentionedCards };
