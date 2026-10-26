const Database = require("better-sqlite3");
const db = new Database(require("path").join(process.cwd(), "data", "tarot.db"), { readonly: true });
const rows = db.prepare("SELECT id, status, error_reason, question, length(reading) rl FROM sessions ORDER BY created_at DESC LIMIT 4").all();
for (const s of rows) {
  console.log(`${s.id} [${s.status}]${s.error_reason ? ` reason=${s.error_reason}` : ""} rl=${s.rl} Q=${s.question}`);
}
console.log();
for (const s of rows.slice(0, 3)) {
  console.log(`=== ${s.id} 工具流水 ===`);
  const tools = db.prepare("SELECT seq, agent, tool, result_summary, duration_ms FROM tool_calls WHERE session_id = ? ORDER BY id").all(s.id);
  for (const t of tools) console.log(`  ${String(t.seq).padStart(2)}. [${t.agent}] ${t.tool} (${t.duration_ms}ms) → ${String(t.result_summary).slice(0, 80)}`);
  console.log(`=== ${s.id} LLM 调用 ===`);
  const calls = db.prepare("SELECT agent, duration_ms, ok, completion_tokens FROM llm_usage WHERE session_id = ? ORDER BY id").all(s.id);
  for (const c of calls) console.log(`  [${c.ok ? "OK" : "FAIL"}] ${c.agent.padEnd(11)} ${String(c.duration_ms).padStart(7)}ms ctok=${c.completion_tokens}`);
  console.log();
}
