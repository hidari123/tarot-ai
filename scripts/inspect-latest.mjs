import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const rows = db.prepare(
  "SELECT id, question, status, error_reason, created_at FROM sessions ORDER BY created_at DESC LIMIT 6"
).all();
for (const x of rows) {
  console.log(`=== ${new Date(x.created_at).toLocaleString("zh-CN")} ${x.status} ${x.error_reason || "-"} | ${x.question.slice(0, 22)}`);
  const ev = db.prepare("SELECT type FROM event_log WHERE session_id = ? ORDER BY seq").all(x.id);
  console.log(`   事件: ${ev.map((e) => e.type).join(" > ")}`);
}
console.log("\n=== 今日 error_reason 分布 ===");
const errs = db.prepare(
  "SELECT error_reason reason, COUNT(*) n FROM sessions WHERE created_at > ? GROUP BY reason ORDER BY n DESC"
).all(Date.now() - 3 * 3600 * 1000);
errs.forEach((e) => console.log(`   ${e.reason}: ${e.n}`));
