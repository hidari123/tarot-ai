/** 检查最近 llm_error / max_rounds 会话的 LLM 调用失败明细 */
const Database = require("better-sqlite3");
const db = new Database(require("path").join(process.cwd(), "data", "tarot.db"), { readonly: true });

const rows = db.prepare(`
  SELECT id, status, error_reason, question, created_at
  FROM sessions WHERE error_reason IS NOT NULL AND error_reason != 'client_disconnect'
  ORDER BY created_at DESC LIMIT 5
`).all();

for (const s of rows) {
  console.log(`\n=== [${s.error_reason}] ${s.question} (${new Date(s.created_at).toLocaleTimeString("zh-CN")}) ===`);
  const calls = db.prepare(`
    SELECT agent, model, duration_ms, ok, prompt_tokens, completion_tokens, created_at
    FROM llm_usage WHERE session_id = ? ORDER BY id
  `).all(s.id);
  for (const c of calls) {
    console.log(`  [${c.ok ? "OK" : "FAIL"}] ${c.agent.padEnd(11)} ${String(c.duration_ms).padStart(7)}ms ptok=${c.prompt_tokens} ctok=${c.completion_tokens} ${new Date(c.created_at).toLocaleTimeString("zh-CN")}`);
  }
  const tools = db.prepare("SELECT seq, tool, result_summary FROM tool_calls WHERE session_id = ? ORDER BY id").all(s.id);
  for (const t of tools) console.log(`  ${String(t.seq).padStart(2)}. ${t.tool} → ${String(t.result_summary).slice(0, 70)}`);
}
