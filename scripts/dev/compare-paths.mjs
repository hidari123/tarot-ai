import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

const done = q("SELECT id, reading, cards_json, review_json FROM sessions WHERE status='done'");
const normal = [], degraded = [];
for (const s of done) {
  const c = db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE session_id=?").get(s.id);
  const rl = (s.reading || "").length;
  const rec = { id: s.id, readingLen: rl, review: !!s.review_json };
  if (c.n === 0) degraded.push(rec); else normal.push(rec);
}
const avg = (a, f) => a.length ? (a.reduce((s, x) => s + f(x), 0) / a.length).toFixed(0) : "-";
console.log("=== 正常路径 vs 降级路径 ===");
console.log(`  正常: ${normal.length} 场 · 平均解读 ${avg(normal, (x) => x.readingLen)} 字 · 有审校 ${normal.filter((x) => x.review).length}`);
console.log(`  降级: ${degraded.length} 场 · 平均解读 ${avg(degraded, (x) => x.readingLen)} 字 · 有审校 ${degraded.filter((x) => x.review).length}`);

const lenDist = (arr) => {
  const b = { "<200": 0, "200-400": 0, "400-800": 0, ">800": 0 };
  for (const x of arr) {
    if (x.readingLen < 200) b["<200"]++;
    else if (x.readingLen < 400) b["200-400"]++;
    else if (x.readingLen < 800) b["400-800"]++;
    else b[">800"]++;
  }
  return b;
};
console.log("\n=== 解读长度分布 ===");
console.log("  正常:", JSON.stringify(lenDist(normal)));
console.log("  降级:", JSON.stringify(lenDist(degraded)));

console.log("\n=== 结论 ===");
const ratio = ((degraded.length / Math.max(1, done.length)) * 100).toFixed(1);
console.log(`  降级占比 ${ratio}% —— 这些会话在 dashboard 的工具统计里完全不可见`);

console.log("\n=== sessions 表里能否区分降级？现有字段 ===");
const cols = q("PRAGMA table_info(sessions)").map((x) => x.name);
console.log("  " + cols.join(", "));
const has = ["degraded", "fallback", "mode", "provider"].filter((k) => cols.some((c) => c.toLowerCase().includes(k)));
console.log(`  含降级标记的列: ${has.length ? has.join(", ") : "❌ 没有"}`);
