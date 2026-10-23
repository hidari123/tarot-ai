/** 查 SQLite 最近会话与工具调用流水 */
const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(process.cwd(), "data", "tarot.db"), { readonly: true });

console.log("=== 最近会话 ===");
const sessions = db.prepare("SELECT id, question, status, length(reading) readingLen, created_at FROM sessions ORDER BY created_at DESC LIMIT 5").all();
for (const s of sessions) {
  console.log(`[${s.status}] ${s.question.slice(0, 30)} | 解读 ${s.readingLen} 字 | ${new Date(s.created_at).toLocaleTimeString("zh-CN")}`);
  console.log(`  id=${s.id}`);
}

console.log("\n=== 工具调用流水（最近会话） ===");
if (sessions[0]) {
  const calls = db.prepare("SELECT seq, agent, tool, result_summary, duration_ms FROM tool_calls WHERE session_id = ? ORDER BY id").all(sessions[0].id);
  for (const c of calls) {
    console.log(`  ${String(c.seq).padStart(2)}. [${c.agent}] ${c.tool} (${c.duration_ms}ms) → ${String(c.result_summary).slice(0, 70)}`);
  }
}

console.log("\n=== LLM 用量 ===");
const usage = db.prepare("SELECT agent, COUNT(*) calls, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, AVG(duration_ms) avgMs FROM llm_usage GROUP BY agent").all();
for (const u of usage) {
  console.log(`  ${u.agent.padEnd(12)} ${u.calls} 次调用 | prompt ${u.pt} tok | completion ${u.ct} tok | 平均 ${Math.round(u.avgMs)}ms`);
}

console.log("\n=== 审校结果 ===");
const reviews = db.prepare("SELECT review_json FROM sessions WHERE review_json != 'null' ORDER BY created_at DESC LIMIT 3").all();
for (const r of reviews) {
  try {
    const rv = JSON.parse(r.review_json);
    console.log(`  pass=${rv.pass} grounding=${rv.scores.grounding} empathy=${rv.scores.empathy} tone=${rv.scores.tone}`);
    console.log(`  ${rv.comment.slice(0, 80)}`);
  } catch {}
}