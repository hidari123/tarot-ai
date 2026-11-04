/**
 * 量化：RAG 缓存 key 设计缺陷（诊断工具，无断言）
 * ⚠️ cacheKey = `${k}|${query}` —— 把"取多少(top_k)"混进了"查什么(query)"。
 *    语义上：同 query 的 top_k=5 与 top_k=10 的**前 5 个结果完全相同**，
 *    所以 k 不该进 key —— 但它进了 → 同 query 因 top_k 变化而重复计算。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

console.log("═══ ① 模型实际传的 top_k 分布 ═══");
const ks = db.prepare(`
  SELECT args_json FROM tool_calls WHERE tool='rag_search'
`).all();
const dist = new Map();
for (const r of ks) {
  try {
    const o = JSON.parse(r.args_json);
    const k = Number(o.top_k) || 5;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  } catch { /* ignore */ }
}
for (const [k, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  top_k=${String(k).padStart(2)}: ${n} 次（${((n / ks.length) * 100).toFixed(1)}%）`);
}
console.log(`  → ${dist.size} 种不同的 top_k`);

console.log("\n═══ ② 同一 query 被不同 top_k 检索了多少次（重复计算）═══");
const byQuery = new Map();
for (const r of ks) {
  try {
    const o = JSON.parse(r.args_json);
    const q = String(o.query ?? "").trim().toLowerCase();
    if (!q) continue;
    const k = Number(o.top_k) || 5;
    const key = `${k}|${q}`;
    byQuery.set(key, (byQuery.get(key) ?? 0) + 1);
  } catch { /* ignore */ }
}
const dupKeys = [...byQuery.entries()].filter(([, n]) => n > 1);
const dupTotal = dupKeys.reduce((s, [, n]) => s + n, 0);
console.log(`  唯一 cache key ${byQuery.size} 个 · 总调用 ${ks.length} 次`);
console.log(`  重复调用（key 相同）: ${dupTotal} 次（${((dupTotal / ks.length) * 100).toFixed(1)}%）→ 这些是缓存命中`);

/** 同一 query 但不同 top_k → 因 k 进 key 而无法复用 */
const qGroups = new Map();
for (const r of ks) {
  try {
    const o = JSON.parse(r.args_json);
    const q = String(o.query ?? "").trim().toLowerCase();
    if (!q) continue;
    const k = Number(o.top_k) || 5;
    if (!qGroups.has(q)) qGroups.set(q, new Set());
    qGroups.get(q).add(k);
  } catch { /* ignore */ }
}
const multiK = [...qGroups.entries()].filter(([, ks2]) => ks2.size > 1);
console.log(`  同一 query 用过多种 top_k 的: ${multiK.length} 个 query`);
if (multiK.length) {
  console.log(`  例：`);
  for (const [q, ks2] of multiK.slice(0, 5)) {
    console.log(`    "${q.slice(0, 30)}" → top_k ${[...ks2].join(", ")}`);
  }
  console.log(`  → 这些本可以复用同一份检索结果（取前 min(k) 个即可）`);
}

console.log("\n═══ ③ 若 key 不含 top_k，理论命中率会是多少 ═══");
const byQueryOnly = new Map();
for (const r of ks) {
  try {
    const o = JSON.parse(r.args_json);
    const q = String(o.query ?? "").trim().toLowerCase();
    if (!q) continue;
    byQueryOnly.set(q, (byQueryOnly.get(q) ?? 0) + 1);
  } catch { /* ignore */ }
}
const hitIfNoK = [...byQueryOnly.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0);
console.log(`  现在（含 top_k）: ${dupTotal} 次可复用`);
console.log(`  改后（不含 top_k）: ${hitIfNoK} 次可复用（多 ${hitIfNoK - dupTotal} 次）`);
console.log(`  → 每次检索 3~4ms + ONNX 推理，多省 ${hitIfNoK - dupTotal} 次 ≈ ${((hitIfNoK - dupTotal) * 4)}ms 同步阻塞`);

console.log("\n═══ ④ 同场内的重复检索（同一场问同一个 query）═══");
const perSess = db.prepare(`
  SELECT session_id, args_json FROM tool_calls WHERE tool='rag_search'
`).all();
const sessMap = new Map();
for (const r of perSess) {
  try {
    const o = JSON.parse(r.args_json);
    const q = String(o.query ?? "").trim().toLowerCase();
    if (!q) continue;
    if (!sessMap.has(r.session_id)) sessMap.set(r.session_id, new Map());
    const m = sessMap.get(r.session_id);
    m.set(q, (m.get(q) ?? 0) + 1);
  } catch { /* ignore */ }
}
let sameSessDup = 0;
for (const m of sessMap.values()) {
  sameSessDup += [...m.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0);
}
console.log(`  同一场内重复检索同一 query: ${sameSessDup} 次`);

db.close();
