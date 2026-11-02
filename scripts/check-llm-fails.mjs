import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const rows = db.prepare(
  `SELECT agent, ok, COUNT(*) n, MAX(created_at) last
   FROM llm_usage WHERE created_at > ? GROUP BY agent, ok ORDER BY agent`
).all(Date.now() - 60 * 60 * 1000);
console.log("近 1 小时 LLM 调用:");
for (const r of rows) {
  console.log(`  ${r.agent.padEnd(12)} ok=${r.ok} ${r.n} 次`);
}
const fails = db.prepare(
  `SELECT agent, error, created_at FROM llm_usage
   WHERE ok = 0 AND created_at > ? ORDER BY created_at DESC LIMIT 6`
).all(Date.now() - 60 * 60 * 1000);
console.log("\n失败明细:");
for (const f of fails) {
  console.log(`  ${new Date(f.created_at).toLocaleTimeString("zh-CN")} ${f.agent}: ${String(f.error).slice(0, 90)}`);
}
