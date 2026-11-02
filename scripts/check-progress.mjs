import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const rows = db.prepare(
  "SELECT COUNT(*) n FROM sessions WHERE created_at > ?"
).get(Date.now() - 300000);
console.log(`近 5 分钟新增会话: ${rows.n}`);
const recent = db.prepare(
  "SELECT question, status, created_at FROM sessions ORDER BY created_at DESC LIMIT 6"
).all();
recent.forEach((r) =>
  console.log(`  ${r.status.padEnd(8)} ${new Date(r.created_at).toLocaleTimeString("zh-CN")} ${r.question.slice(0, 28)}`)
);
const st = db.prepare(
  "SELECT stage, COUNT(*) n FROM session_timings WHERE created_at > ? GROUP BY stage ORDER BY n DESC LIMIT 6"
).all(Date.now() - 300000);
console.log(`\n近 5 分钟阶段耗时分布: ${st.map((s) => `${s.stage}×${s.n}`).join(", ")}`);
