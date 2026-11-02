import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const rows = db.prepare(
  "SELECT id, question, created_at, state_json FROM sessions WHERE status='running' ORDER BY created_at DESC"
).all();
for (const r of rows) {
  let lastActive = null, hasSnap = r.state_json !== "";
  try { lastActive = JSON.parse(r.state_json).lastActive; } catch { /* ignore */ }
  const ageMin = ((Date.now() - (lastActive ?? r.created_at)) / 60000).toFixed(1);
  console.log(
    `  ${r.question.slice(0, 20).padEnd(22)} snap=${hasSnap ? "有" : "无"} ` +
    `lastActive=${lastActive ? new Date(lastActive).toLocaleString("zh-CN") : "-"} ` +
    `(${ageMin} 分钟前)`
  );
}
console.log(`\n阈值: SESSION_TTL = 30 分钟 → 超过就该被标 error`);
