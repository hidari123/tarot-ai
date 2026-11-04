/**
 * 诊断：收束（closing）阶段的真实行为（无断言，只看数据）
 * ⚠️ 用户报告"每次回答完问题都停在那里" —— 需要看清到底是
 *    ① 模型没调 close_reading？
 *    ② 调了但被守卫拦？
 *    ③ 调了，问了，用户答了，然后卡住？
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

console.log("═══ ① 最近 15 场的工具调用序列（看是否走到 close_reading）═══\n");
const sessions = db.prepare(`
  SELECT id, status, error_reason, created_at FROM sessions
  WHERE length(id) > 30 ORDER BY created_at DESC LIMIT 15
`).all();

for (const s of sessions) {
  const calls = db.prepare(`
    SELECT tool FROM tool_calls WHERE session_id=? ORDER BY id
  `).all(s.id).map((r) => r.tool);

  const hasClosing = calls.includes("close_reading");
  const closingCount = calls.filter((t) => t === "close_reading").length;
  const mark = hasClosing ? (closingCount > 1 ? `⚠️ close×${closingCount}` : "✅") : "❌ 无close";

  console.log(`  ${s.id.slice(0, 14)} ${s.status.padEnd(6)} ${(s.error_reason || "-").padEnd(18)} ${mark}`);
  console.log(`      ${calls.join(" → ") || "(无工具调用)"}`);
}

console.log("\n═══ ② 全库：close_reading 的调用分布 ═══");
const dist = db.prepare(`
  SELECT n, COUNT(*) sessions FROM (
    SELECT session_id, COUNT(*) n FROM tool_calls WHERE tool='close_reading' GROUP BY session_id
  ) GROUP BY n ORDER BY n
`).all();
console.log("  每场的 close_reading 次数 → 场数：");
for (const d of dist) console.log(`    ${d.n} 次 → ${d.sessions} 场`);

const total = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE length(id) > 30`).get().c;
const withClosing = db.prepare(`SELECT COUNT(DISTINCT session_id) c FROM tool_calls WHERE tool='close_reading'`).get().c;
console.log(`  有 close_reading 的会话：${withClosing} / ${total}`);

console.log("\n═══ ③ 收束提问之后发生了什么：ask 事件之后还有没有事件 ═══");
const withAsk = db.prepare(`
  SELECT session_id FROM tool_calls WHERE tool='close_reading'
  GROUP BY session_id ORDER BY MAX(id) DESC LIMIT 3
`).all();
for (const s of withAsk) {
  const evs = db.prepare(`
    SELECT type, COUNT(*) n FROM event_log WHERE session_id=? GROUP BY type ORDER BY MIN(id)
  `).all(s.session_id);
  console.log(`  ${s.session_id.slice(0, 14)}: ${evs.map((e) => `${e.type}×${e.n}`).join(" ")}`);
}

console.log("\n═══ ④ hitl_wait 落库情况（收束那次等多久、什么 kind）═══");
const timings = db.prepare(`
  SELECT s.id, t.stage, t.duration_ms FROM session_timings t JOIN sessions s ON s.id=t.session_id
  WHERE t.stage='hitl_wait' ORDER BY t.id DESC LIMIT 15
`).all();
for (const t of timings) {
  console.log(`  ${t.id.slice(0, 14)} stage=${t.stage} ${Math.round(t.duration_ms / 1000)}s`);
}

db.close();
