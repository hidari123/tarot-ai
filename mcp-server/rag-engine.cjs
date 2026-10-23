/**
 * MCP Server 用的 BM25 检索（从 rag-engine 移植核心逻辑，无 TS alias）
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

function ragSearch(query, topK = 5) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
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

  if (deduped.length === 0) return [];
  const top = deduped[0].score;
  return deduped.map(({ chunk, score }) => ({
    chunkId: chunk.id, cardId: chunk.cardId, cardNameZh: chunk.cardNameZh, field: chunk.field,
    score: Math.round((score / top) * 100) / 100,
    snippet: chunk.text.length > 80 ? chunk.text.slice(0, 80) + "…" : chunk.text,
    source: `tarot-lab · ${chunk.cardNameZh} · ${chunk.field === "description" ? "牌面叙事" : chunk.field === "upright" ? "正位牌意" : chunk.field === "reversed" ? "逆位牌意" : "关键词"}`,
  }));
}

module.exports = { ragSearch, KNOWLEDGE_CHUNKS };
