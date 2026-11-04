/**
 * 实测：投机预检索是否真的被后续 rag_search 命中（诊断工具，无断言）
 *
 * ⚠️ 背景：
 *   prefetchForCard 用 rewriteQueryLocal(牌名) 作为 cacheKey
 *   execRagSearch  用 rewriteQueryLocal(模型 query + 候选牌名) 作为 cacheKey
 *   两个 key 很可能不同 → 预检索结果永远不被复用 → 纯重复劳动
 *   且 hybridSearch 是**同步 CPU 计算** → 预检索并不"提前"，只是多同步算一遍。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

const { rewriteQueryLocal } = await import("../../src/lib/query-rewrite.ts");
const { TAROT_CARDS } = await import("../../src/lib/tarot-cards.ts");

const cardNames = TAROT_CARDS.map((c) => c.nameZh);

/** 复刻 rag.ts 的 cacheKey */
const cacheKey = (query, k) => `${k}|${query.replace(/\s+/g, " ").trim().toLowerCase()}`;

console.log("═══ ① 预取牌名 vs 实际 rag_search query 的 key 对比 ═══\n");

const rows = db.prepare(`
  SELECT session_id, tool, args_json, seq FROM tool_calls
  WHERE tool = 'rag_search' AND session_id LIKE 'sess_%'
  ORDER BY id DESC LIMIT 60
`).all();

let matched = 0, total = 0;
const samples = [];
for (const r of rows) {
  let args;
  try { args = JSON.parse(r.args_json); } catch { continue; }
  const q = String(args.query ?? "");
  if (!q) continue;
  total++;
  const rewritten = rewriteQueryLocal(q, cardNames);
  const key = cacheKey(rewritten, Number(args.top_k) || 5);

  // ⚠️ 预检索会为**每一张已翻的牌**做一次检索，key = 牌名
  const prefetchKeys = cardNames.map((n) => cacheKey(rewriteQueryLocal(n, cardNames), 5));
  const hit = prefetchKeys.includes(key);
  if (hit) matched++;
  if (samples.length < 8) {
    samples.push({
      q: q.slice(0, 34),
      rewritten: rewritten.slice(0, 44),
      key: key.slice(0, 60),
      hit,
    });
  }
}

for (const s of samples) {
  console.log(`  query: "${s.q}"`);
  console.log(`    改写后 key: ${s.key}`);
  console.log(`    预取牌名 key 能命中? ${s.hit ? "✅ 命中" : "❌ 不命中（纯重复计算）"}`);
  console.log();
}
console.log(`  统计：${matched} / ${total} 次 rag_search 能命中预取缓存（${((matched / Math.max(1, total)) * 100).toFixed(1)}%）`);

console.log("\n═══ ② 预检索的重复劳动量 ═══");
const prefetchCount = db.prepare(`
  SELECT COUNT(*) c FROM tool_calls WHERE tool='reveal_card'
`).get().c;
const ragCount = db.prepare(`SELECT COUNT(*) c FROM tool_calls WHERE tool='rag_search'`).get().c;
console.log(`  reveal_card ${prefetchCount} 次（每次触发一次预检索）· rag_search ${ragCount} 次`);
console.log(`  → 预检索做了约 ${prefetchCount} 次同步检索，其中命中后续 rag_search 的仅 ${matched} 次`);

console.log("\n═══ ③ hybridSearch 是否同步（阻塞事件循环）═══");
const { hybridSearch } = await import("../../src/lib/rag-engine.ts");
const t0 = Date.now();
hybridSearch("权杖七", 5);
const syncMs = Date.now() - t0;
console.log(`  hybridSearch("权杖七", 5) 同步耗时 ${syncMs}ms`);
console.log(`  → 若是同步 API，这 ${syncMs}ms 直接阻塞 Node 事件循环（所有并发 SSE 流一起卡）`);

db.close();
