/**
 * 深挖：单场占卜的 message 结构与每轮增量来源（诊断工具，无断言）
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log("═══ ① 单场 22 次调用的会话里，assistant 消息的 content 长度 ═══");
const s = q(`
  SELECT u.session_id FROM llm_usage u JOIN sessions s ON s.id=u.session_id
  WHERE s.status='done' AND s.error_reason=''
  GROUP BY u.session_id HAVING COUNT(*) >= 20 LIMIT 1
`);
if (!s.length) { console.log("  无匹配会话"); process.exit(0); }
const sid = s[0].session_id;
console.log(`  会话 ${sid}`);

// ⚠️ messages 在 state_json 里（快照）
const row = db.prepare("SELECT state_json FROM sessions WHERE id=?").get(sid);
const snap = JSON.parse(row.state_json || "{}");
const msgs = snap.messages || [];
console.log(`  快照里 messages 长度: ${msgs.length} 条`);

console.log("\n  每条消息的角色 / 长度 / 工具：");
let totalChars = 0;
for (const m of msgs) {
  const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
  totalChars += c.length;
  const tools = m.tool_calls?.map((t) => t.function.name).join(",") ?? "";
  const kind = m.role === "assistant"
    ? (m.tool_calls ? `调用[${tools}]` : "文本")
    : m.role === "tool" ? "工具结果" : m.role;
  console.log(`    ${String(m.role).padEnd(10)} ${String(c.length).padStart(7)} 字  ${kind.padEnd(28)} ${c.slice(0, 60).replace(/\n/g, " ")}`);
}
console.log(`  合计 ${totalChars} 字 ≈ ${Math.round(totalChars / 2.5)} tokens（中文约 2.5 字/token）`);

console.log("\n═══ ② 工具结果的体积排行（最大的上下文消耗源）═══");
const toolChars = new Map();
for (const m of msgs) {
  if (m.role !== "tool") continue;
  const c = typeof m.content === "string" ? m.content : "";
  const key = m.tool_call_id || "unknown";
  toolChars.set(key, (toolChars.get(key) || 0) + c.length);
}
const sorted = [...toolChars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [k, v] of sorted) console.log(`    ${k.slice(0, 14)} ${String(v).padStart(6)} 字`);

console.log("\n═══ ③ 轮次数：22 次 vs 声称的 14 次 ═══");
const calls = q(`SELECT agent, COUNT(*) n FROM llm_usage WHERE session_id=? GROUP BY agent`, sid);
for (const c of calls) console.log(`  ${c.agent.padEnd(12)} ${c.n} 次`);

console.log("\n═══ ④ 历史上各会话的 supervisor 调用次数分布 ═══");
const dist = q(`
  SELECT n_calls, COUNT(*) sessions FROM (
    SELECT session_id, COUNT(*) n_calls FROM llm_usage WHERE agent='supervisor' GROUP BY session_id
  ) GROUP BY n_calls ORDER BY n_calls
`);
for (const d of dist) console.log(`  ${String(d.n_calls).padStart(3)} 次调用: ${d.sessions} 场`);

console.log("\n═══ ⑤ 拦截率（我加的守卫是否导致重试）═══");
const toolNames = q(`
  SELECT tool, COUNT(*) n FROM tool_calls WHERE session_id=? GROUP BY tool ORDER BY n DESC`, sid);
for (const t of toolNames) console.log(`  ${t.tool.padEnd(24)} ${t.n} 次`);

db.close();
