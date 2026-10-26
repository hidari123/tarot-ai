/** 诊断：最近失败会话的轮次轨迹（什么工具序列导致 max_rounds / 卡死） */
const Database = require("better-sqlite3");
const db = new Database(require("path").join(process.cwd(), "data", "tarot.db"), { readonly: true });

const rows = db.prepare(`
  SELECT id, status, error_reason, question, length(reading) rl, created_at
  FROM sessions ORDER BY created_at DESC LIMIT 8
`).all();

for (const s of rows) {
  const age = Math.round((Date.now() - s.created_at) / 60000);
  console.log(`\n[${s.status}]${s.error_reason ? `(${s.error_reason})` : ""} ${s.question} (rl=${s.rl}, ${age}min ago)`);
  const tools = db.prepare(`
    SELECT seq, tool, result_summary, duration_ms FROM tool_calls WHERE session_id = ? ORDER BY id
  `).all(s.id);
  if (tools.length === 0) { console.log("  (无工具调用)"); continue; }
  for (const t of tools) {
    console.log(`  ${String(t.seq).padStart(2)}. ${t.tool.padEnd(20)} ${String(t.result_summary).slice(0, 70)}`);
  }
  // LLM 调用次数 vs 工具轮次
  const calls = db.prepare("SELECT COUNT(*) n FROM llm_usage WHERE session_id = ? AND agent='supervisor'").get(s.id);
  console.log(`  → supervisor 决策 ${calls.n} 次 / 工具 ${tools.length} 次`);
}

// 统计：max_rounds 会话的常见工具序列
console.log("\n=== 失败原因统计（全部会话） ===");
const stats = db.prepare(`
  SELECT COALESCE(error_reason, status) reason, COUNT(*) n FROM sessions GROUP BY reason ORDER BY n DESC
`).all();
for (const s of stats) console.log(`  ${s.reason}: ${s.n}`);
