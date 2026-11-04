/**
 * 验证：上一轮的修复是否真的降低了失败率（诊断工具，无断言）
 * 对比口径：按 session id 格式区分"改造前(旧格式)"与"改造后(新格式)"。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

/** 新格式 = sess_ + 32 字符 base64url；旧格式 = sess_xxx_xxxxxxxx（短） */
const isNew = "length(id) > 30";

console.log("═══ ① 改造前 vs 改造后：会话终态 ═══");
for (const [label, where] of [
  ["改造前（旧 id 格式）", `length(id) <= 30`],
  ["改造后（新 id 格式）", isNew],
]) {
  const rows = db.prepare(`SELECT status, COUNT(*) n FROM sessions WHERE ${where} GROUP BY status`).all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  if (!total) { console.log(`  ${label}: 无数据`); continue; }
  const done = rows.find((r) => r.status === "done");
  console.log(`  ${label}: 共 ${total} 场 · done ${done?.n ?? 0}（${(((done?.n ?? 0) / total) * 100).toFixed(1)}%）· error ${total - (done?.n ?? 0)}（${(((total - (done?.n ?? 0)) / total) * 100).toFixed(1)}%）`);
}

console.log("\n═══ ② 改造后：失败原因 ═══");
const reasons = db.prepare(`
  SELECT error_reason, COUNT(*) n FROM sessions
  WHERE ${isNew} AND error_reason != '' GROUP BY error_reason ORDER BY n DESC
`).all();
const totalNew = db.prepare(`SELECT COUNT(*) n FROM sessions WHERE ${isNew}`).get().n;
for (const r of reasons) {
  console.log(`  ${r.error_reason.padEnd(20)} ${String(r.n).padStart(4)} 场（占全部改造后会话 ${((r.n / totalNew) * 100).toFixed(1)}%）`);
}

console.log("\n═══ ③ 改造后：client_disconnect 的发生时机（abort 修复的效果）═══");
// ⚠️ 如果 abort 修复有效 → 用户点"重新开始"会触发 client_disconnect，
//    且这些会话的**工具调用数应该很少**（早退出，不白烧 token）
const cd = db.prepare(`
  SELECT s.id, s.created_at, s.finished_at,
    (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) tools,
    (SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) FROM llm_usage u WHERE u.session_id = s.id) tokens
  FROM sessions s WHERE ${isNew} AND s.error_reason='client_disconnect'
  ORDER BY s.created_at DESC LIMIT 20
`).all();
if (cd.length) {
  const avgTools = cd.reduce((s, r) => s + r.tools, 0) / cd.length;
  const avgTokens = cd.reduce((s, r) => s + r.tokens, 0) / cd.length;
  const early = cd.filter((r) => r.tools <= 2).length;
  console.log(`  最近 ${cd.length} 场 client_disconnect：平均 ${avgTools.toFixed(1)} 次工具调用 · 平均 ${Math.round(avgTokens)} tokens`);
  console.log(`  其中 ${early}/${cd.length} 场在 ≤2 次工具调用就断开（早退出 = 没白烧 token）`);
  console.log("  → 早退出比例高 = abort 修复生效（用户主动取消时代理立刻停）");
}

console.log("\n═══ ④ 表的增长（清理策略覆盖情况）═══");
const cleanup = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'`).get();
const tables = ["sessions", "tool_calls", "llm_usage", "event_log", "session_timings", "user_profiles"];
for (const t of tables) {
  const c = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  console.log(`  ${t.padEnd(16)} ${String(c).padStart(7)} 行`);
}
console.log("\n  每日清理覆盖的表（查 cleanup 代码）：");
const dbSrc = (await import("node:fs")).readFileSync("src/lib/db.ts", "utf-8");
const cleanupBlock = dbSrc.match(/DELETE FROM \w+/g) || [];
console.log(`    ${cleanupBlock.join(", ") || "（未找到）"}`);

console.log("\n═══ ⑤ state_json 写放大 ═══");
const sj = db.prepare(`SELECT AVG(length(state_json)) avg, MAX(length(state_json)) max FROM sessions WHERE state_json != ''`).get();
console.log(`  平均快照 ${Math.round(sj.avg ?? 0)} 字节 · 最大 ${Math.round(sj.max ?? 0)} 字节`);
console.log(`  每 10 秒重写一次脏会话 → 一场 14 轮占卜约 ${14} 次全量写`);

db.close();
