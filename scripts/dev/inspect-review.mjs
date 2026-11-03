import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log("=== sessions 表结构 ===");
for (const r of q("PRAGMA table_info(sessions)")) {
  console.log(`  ${r.name.padEnd(22)} ${r.type}`);
}

console.log("\n=== llm_usage 的 session_id 覆盖率 ===");
const t = q(`SELECT
  (SELECT COUNT(*) FROM llm_usage) total_usage,
  (SELECT COUNT(*) FROM llm_usage WHERE session_id IS NULL OR session_id='') null_sid,
  (SELECT COUNT(DISTINCT session_id) FROM llm_usage WHERE session_id IS NOT NULL AND session_id!='') distinct_sid,
  (SELECT COUNT(*) FROM sessions) total_sessions`);
console.log(`  llm_usage 总行 ${t[0].total_usage} · 无 session_id ${t[0].null_sid} · 覆盖会话数 ${t[0].distinct_sid} / ${t[0].total_sessions}`);

console.log("\n=== agent 维度分布（含 session_id 为空的）===");
for (const r of q(`SELECT agent, COUNT(*) n, SUM(CASE WHEN session_id IS NULL OR session_id='' THEN 1 ELSE 0 END) no_sid
  FROM llm_usage GROUP BY agent ORDER BY n DESC`)) {
  console.log(`  ${r.agent.padEnd(12)} ${String(r.n).padStart(5)} 次 · 其中无 session_id ${r.no_sid}`);
}

console.log("\n=== 无 session_id 的调用占比（数据关联断裂）===");
const r = q(`SELECT COUNT(*) n FROM llm_usage WHERE session_id IS NULL OR session_id=''`);
console.log(`  ${r[0].n} / ${q("SELECT COUNT(*) n FROM llm_usage")[0].n} = ${((r[0].n / q("SELECT COUNT(*) n FROM llm_usage")[0].n) * 100).toFixed(1)}%`);

console.log("\n=== sessions 表有哪些列能统计轮次 ===");
const cols = q("PRAGMA table_info(sessions)").map((x) => x.name);
console.log("  " + cols.join(", "));

console.log("\n=== 审校 JSON 原始样本（看解析失败长什么样）===");
const samples = q("SELECT id, substr(review_json,1,300) j FROM sessions WHERE review_json IS NOT NULL AND review_json != '' LIMIT 6");
for (const s of samples) {
  console.log(`\n  --- ${s.id} ---`);
  console.log("  " + (s.j || "(空)").replace(/\n/g, "\n  "));
}
