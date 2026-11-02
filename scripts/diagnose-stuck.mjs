import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const rows = db.prepare(
  "SELECT id, question, status, error_reason, created_at FROM sessions WHERE created_at > ? ORDER BY created_at DESC LIMIT 6"
).all(Date.now() - 15 * 60 * 1000);
for (const r of rows) {
  console.log(`\n=== ${r.status} ${(r.error_reason || "-")} :: ${r.question.slice(0, 30)}`);
  const ev = db.prepare(
    "SELECT seq, type FROM event_log WHERE session_id = ? ORDER BY seq"
  ).all(r.id);
  console.log(`  事件数 ${ev.length}: ${ev.slice(-12).map((e) => e.type).join(" > ")}`);
  const tm = db.prepare(
    "SELECT stage, detail, duration_ms FROM session_timings WHERE session_id = ? ORDER BY id DESC LIMIT 6"
  ).all(r.id);
  console.log(`  最近阶段: ${tm.map((t) => `${t.stage}(${t.duration_ms}ms)`).join(", ")}`);
  const tools = db.prepare(
    "SELECT tool, result_summary FROM tool_calls WHERE session_id = ? ORDER BY id DESC LIMIT 6"
  ).all(r.id);
  console.log(`  最近工具: ${tools.map((t) => t.tool).join(" > ") || "无"}`);
}
