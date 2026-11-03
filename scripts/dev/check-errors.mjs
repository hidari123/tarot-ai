import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const rows = db.prepare(
  "SELECT id, question, status, error_reason, created_at FROM sessions WHERE created_at > ? ORDER BY created_at DESC LIMIT 12"
).all(Date.now() - 20 * 60 * 1000);
console.log("最近 20 分钟会话:");
for (const r of rows) {
  console.log(
    `  ${r.status.padEnd(8)} ${(r.error_reason || "-").padEnd(18)} ${r.question.slice(0, 30)}`
  );
}
const errs = db.prepare(
  "SELECT error_reason reason, COUNT(*) n FROM sessions WHERE status='error' AND created_at > ? GROUP BY reason"
).all(Date.now() - 60 * 60 * 1000);
console.log(`\n近 1 小时错误分类: ${errs.map((e) => `${e.reason}×${e.n}`).join(", ") || "无"}`);
