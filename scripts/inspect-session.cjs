/** 深挖指定会话：LLM 调用明细 + 工具流水 + 消息历史尾部 */
const Database = require("better-sqlite3");
const path = require("path");
const db = new Database(path.join(process.cwd(), "data", "tarot.db"), { readonly: true });

const sid = process.argv[2];
if (!sid) { console.log("usage: node scripts/inspect-session.cjs <sessionId>"); process.exit(1); }

console.log(`=== 会话 ${sid} 的 LLM 调用明细 ===`);
const calls = db.prepare(`
  SELECT agent, model, prompt_tokens, completion_tokens, duration_ms, ok, created_at
  FROM llm_usage WHERE session_id = ? ORDER BY id
`).all(sid);
if (calls.length === 0) console.log("(无记录)");
for (const c of calls) {
  console.log(`  [${c.ok ? "OK" : "FAIL"}] ${c.agent.padEnd(11)} ${String(c.duration_ms).padStart(7)}ms  ptok=${c.prompt_tokens} ctok=${c.completion_tokens}  ${new Date(c.created_at).toLocaleTimeString("zh-CN")}`);
}

console.log(`\n=== 工具流水 ===`);
const tools = db.prepare(`
  SELECT seq, agent, tool, result_summary, duration_ms, created_at
  FROM tool_calls WHERE session_id = ? ORDER BY id
`).all(sid);
if (tools.length === 0) console.log("(无记录)");
for (const t of tools) {
  console.log(`  ${String(t.seq).padStart(2)}. [${t.agent}] ${t.tool} (${t.duration_ms}ms) → ${String(t.result_summary).slice(0, 80)}`);
}

console.log(`\n=== 会话状态 ===`);
const s = db.prepare(`SELECT status, length(reading) rl, created_at, finished_at FROM sessions WHERE id = ?`).get(sid);
console.log(JSON.stringify(s, null, 2));
