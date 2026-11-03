import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const dist = db.prepare("SELECT status, COUNT(*) n FROM sessions GROUP BY status").all();
console.log("会话状态分布:", dist.map((x) => `${x.status}=${x.n}`).join(", "));
const running = db.prepare(
  "SELECT id, question, created_at FROM sessions WHERE status='running' ORDER BY created_at DESC LIMIT 12"
).all();
console.log(`\nrunning 会话 ${running.length} 条：`);
for (const r of running) {
  const age = ((Date.now() - r.created_at) / 60000).toFixed(1);
  console.log(`  ${age}分钟前  ${r.question.slice(0, 26)}`);
}
