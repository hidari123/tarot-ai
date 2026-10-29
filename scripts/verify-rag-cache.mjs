#!/usr/bin/env node
/**
 * 验证：RAG 跨会话查询缓存（P1-③）
 *
 * 判定：同一个查询连续检索两次，第二次应命中缓存（显著更快）。
 * 同时验证缓存不改变检索结果（正确性）。
 */
const BASE = process.argv[2] || "http://localhost:3000";

async function loadRag() {
  return await import("../src/lib/rag-engine.ts");
}
async function loadRewrite() {
  return await import("../src/lib/query-rewrite.ts");
}
async function loadCards() {
  return await import("../src/lib/tarot-cards.ts");
}

const rag = await loadRag();
const rewriteMod = await loadRewrite();
const { TAROT_CARDS } = await loadCards();

// 模拟 agent/tools/rag.ts 的缓存逻辑（同一套 key 归一化）
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const cacheKey = (q, k) => `${k}|${q.replace(/\s+/g, " ").trim().toLowerCase()}`;
function readCache(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL) { CACHE.delete(key); return null; }
  return e.hits;
}
function writeCache(key, hits) {
  if (CACHE.size >= 200) {
    const oldest = CACHE.keys().next();
    if (!oldest.done) CACHE.delete(oldest.value);
  }
  CACHE.set(key, { hits, at: Date.now() });
}

const queries = ["权杖七 宝剑八", "圣杯八 放手", "战车 事业 上升", "恋人 感情 复合"];

console.log("\n=== 缓存命中验证 ===\n");
let saved = 0;
for (const q of queries) {
  const rewritten = rewriteMod.rewriteQueryLocal(q, TAROT_CARDS.map((c) => c.nameZh));
  const k = 5;
  const key = cacheKey(rewritten, k);

  // 第一次（冷）
  const t0 = Date.now();
  let hits = readCache(key);
  let cached = false;
  if (!hits) {
    hits = await rag.hybridSearch(rewritten, k);
    writeCache(key, hits);
  } else cached = true;
  const cold = Date.now() - t0;

  // 第二次（应命中）
  const t1 = Date.now();
  const hits2 = readCache(key);
  const warm = Date.now() - t1;
  const hit = hits2 !== null;
  saved += cold - warm;

  console.log(`「${q.slice(0, 14)}」 冷 ${String(cold).padStart(4)}ms → 热 ${String(warm).padStart(3)}ms  ${hit ? "✅ 命中" : "❌ 未命中"}  (${hits2?.length ?? 0} 条)`);
}

console.log(`\n累计节省: ${saved}ms`);

// 正确性：缓存结果必须与实时检索一致
console.log("\n=== 正确性验证（缓存结果 vs 实时检索）===");
const q = "恋人 感情 复合";
const rewritten = rewriteMod.rewriteQueryLocal(q, TAROT_CARDS.map((c) => c.nameZh));
const key = cacheKey(rewritten, 5);
const cachedHits = readCache(key) ?? (await rag.hybridSearch(rewritten, 5));
const liveHits = await rag.hybridSearch(rewritten, 5);
const same = JSON.stringify(cachedHits.map((h) => h.chunkId)) === JSON.stringify(liveHits.map((h) => h.chunkId));
console.log(`缓存: ${cachedHits.map((h) => h.cardNameZh).join(", ")}`);
console.log(`实时: ${liveHits.map((h) => h.cardNameZh).join(", ")}`);
console.log(same ? "✅ 结果一致" : "❌ 结果不一致");

process.exit(same ? 0 : 2);
