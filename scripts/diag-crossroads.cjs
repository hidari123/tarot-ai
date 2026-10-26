/** 诊断：最新会话的完整工具轨迹 + ask_user 事件的实际内容 */
const Database = require("better-sqlite3");
const db = new Database(require("path").join(process.cwd(), "data", "tarot.db"), { readonly: true });

const s = db.prepare("SELECT id, status, error_reason, question, created_at FROM sessions ORDER BY created_at DESC LIMIT 1").get();
console.log(`会话 ${s.id} [${s.status}]${s.error_reason ? ` (${s.error_reason})` : ""} Q=${s.question}`);

const tools = db.prepare("SELECT seq, tool, args_json, result_summary, created_at FROM tool_calls WHERE session_id = ? ORDER BY id").all(s.id);
for (const t of tools) {
  const a = JSON.parse(t.args_json || "{}");
  const keys = Object.keys(a);
  console.log(`\n${String(t.seq).padStart(2)}. ${t.tool} @ ${new Date(t.created_at).toLocaleTimeString("zh-CN")}`);
  console.log(`    keys: ${keys.join(",")}`);
  for (const k of keys) {
    const v = a[k];
    const isArr = Array.isArray(v);
    console.log(`    ${k}: ${isArr ? `ARRAY(${v.length})` : typeof v} = ${JSON.stringify(v)?.slice(0, 200)}`);
  }
  console.log(`    → ${String(t.result_summary).slice(0, 90)}`);
}
