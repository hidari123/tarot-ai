/**
 * 数据体检（诊断工具，无断言 —— 用完即弃）
 * 目的：找出**当前最大的问题**，而不是列一堆"听起来该优化"的点。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

console.log("═══ ① 会话终态分布 ═══");
const status = q(`SELECT status, COUNT(*) n FROM sessions GROUP BY status`);
const total = status.reduce((s, r) => s + r.n, 0);
for (const r of status) {
  console.log(`  ${r.status.padEnd(8)} ${String(r.n).padStart(4)} 场  ${((r.n / total) * 100).toFixed(1)}%`);
}
console.log(`  合计 ${total} 场`);

console.log("\n═══ ② 失败原因（最大的改进空间在这里）═══");
const reasons = q(`SELECT error_reason, COUNT(*) n FROM sessions
  WHERE error_reason != '' GROUP BY error_reason ORDER BY n DESC`);
for (const r of reasons) {
  console.log(`  ${r.error_reason.padEnd(20)} ${String(r.n).padStart(4)} 场  ${((r.n / total) * 100).toFixed(1)}%`);
}
// ⚠️ 关键：这些失败发生在**第几次工具调用**？早失败 = 快速失败（好）；晚失败 = 白烧了 token
console.log("\n  各失败原因的平均工具调用数（早失败=省 token）：");
for (const r of reasons) {
  const a = one(`SELECT AVG(c) avg FROM (
    SELECT COUNT(*) c FROM tool_calls tc JOIN sessions s ON s.id=tc.session_id
    WHERE s.error_reason=? GROUP BY tc.session_id)`, r.error_reason);
  console.log(`    ${r.error_reason.padEnd(20)} ${(a?.avg ?? 0).toFixed(1)} 次`);
}

console.log("\n═══ ③ TTL 过期的真相（用户为什么走那么久）═══");
const ttl = one(`SELECT COUNT(*) n FROM sessions WHERE error_reason='ttl_expired'`);
const ttlDur = one(`SELECT AVG(finished_at-created_at) d FROM sessions WHERE error_reason='ttl_expired' AND finished_at IS NOT NULL`);
console.log(`  ttl_expired ${ttl.n} 场，平均存活 ${Math.round((ttlDur?.d ?? 0) / 1000)} 秒`);
console.log(`  ⚠️ 会话 TTL = 30 分钟，但 HITL 超时 = 5 分钟`);
console.log(`  ⚠️ 说明：这些会话不是"卡住"，而是**用户在 30 分钟内离开了**（没答完 HITL）`);

console.log("\n═══ ④ token 消耗结构（最贵的部分在哪）═══");
const byAgent = q(`SELECT agent, COUNT(*) n, SUM(prompt_tokens) pt, SUM(completion_tokens) ct
  FROM llm_usage GROUP BY agent ORDER BY (pt+ct) DESC`);
const grand = byAgent.reduce((s, r) => s + r.pt + r.ct, 0);
for (const r of byAgent) {
  const t = r.pt + r.ct;
  console.log(`  ${r.agent.padEnd(12)} 调用 ${String(r.n).padStart(5)}  prompt ${String(r.pt).padStart(9)}  completion ${String(r.ct).padStart(8)}  占比 ${((t / grand) * 100).toFixed(1)}%`);
}
console.log(`  总计 ${grand.toLocaleString()} tokens`);

console.log("\n═══ ⑤ 单场 token 分布（长尾在哪）═══");
const dist = q(`
  SELECT s.id, SUM(u.prompt_tokens+u.completion_tokens) t
  FROM sessions s JOIN llm_usage u ON u.session_id=s.id
  WHERE s.status='done' GROUP BY s.id ORDER BY t DESC`);
if (dist.length) {
  const ts = dist.map((d) => d.t);
  const sum = ts.reduce((a, b) => a + b, 0);
  const sorted = [...ts].sort((a, b) => a - b);
  console.log(`  样本 ${ts.length} 场 · 均值 ${Math.round(sum / ts.length)} · 中位 ${sorted[Math.floor(ts.length / 2)]}`);
  console.log(`  P90 ${sorted[Math.floor(ts.length * 0.9)]} · P99 ${sorted[Math.floor(ts.length * 0.99)]} · 最大 ${sorted[sorted.length - 1]}`);
  const top10 = sorted.slice(-10).reduce((a, b) => a + b, 0);
  console.log(`  ⚠️ 最贵的 10 场占总量 ${((top10 / sum) * 100).toFixed(1)}%`);
}

console.log("\n═══ ⑥ 单次调用的 prompt 结构（supervisor 的上下文有多贵）═══");
const sup = q(`SELECT prompt_tokens, completion_tokens, duration_ms FROM llm_usage WHERE agent='supervisor' ORDER BY id`);
if (sup.length) {
  const avg = Math.round(sup.reduce((s, r) => s + r.prompt_tokens, 0) / sup.length);
  const first = sup[0].prompt_tokens;
  const last = sup[sup.length - 1].prompt_tokens;
  console.log(`  supervisor 调用 ${sup.length} 次 · 平均 prompt ${avg} tokens`);
  console.log(`  首个 prompt ${first} → 末个 prompt ${last} （增长 ${(last / first).toFixed(1)}×）`);
  const totalP = sup.reduce((s, r) => s + r.prompt_tokens, 0);
  console.log(`  supervisor 总 prompt ${totalP.toLocaleString()} tokens = 全量的 ${((totalP / grand) * 100).toFixed(1)}%`);
}

console.log("\n═══ ⑦ 审校与重写（质量成本）═══");
const rev = one(`SELECT COUNT(*) n FROM (SELECT session_id FROM llm_usage WHERE agent='writer' GROUP BY session_id HAVING COUNT(*)>1)`);
const writerTotal = one(`SELECT COUNT(DISTINCT session_id) n FROM llm_usage WHERE agent='writer'`);
console.log(`  发生过重写的会话: ${rev.n} / ${writerTotal.n} = ${((rev.n / Math.max(1, writerTotal.n)) * 100).toFixed(1)}%`);
const rerunPass = one(`SELECT COUNT(*) n FROM llm_usage WHERE agent='reviewer'`);
console.log(`  reviewer 调用 ${rerunPass.n} 次`);

console.log("\n═══ ⑧ 耗时分布（用户等多久）═══");
const dur = q(`SELECT s.finished_at-s.created_at d FROM sessions WHERE status='done' AND finished_at IS NOT NULL`);
if (dur.length) {
  const ds = dur.map((d) => d.d / 1000).sort((a, b) => a - b);
  console.log(`  均值 ${Math.round(ds.reduce((a, b) => a + b, 0) / ds.length)}s · 中位 ${Math.round(ds[Math.floor(ds.length / 2)])}s · P90 ${Math.round(ds[Math.floor(ds.length * 0.9)])}s · 最大 ${Math.round(ds[ds.length - 1])}s`);
}

console.log("\n═══ ⑨ 降级路径真的触发过吗 ═══");
const fb = one(`SELECT COUNT(*) n FROM llm_usage WHERE agent='supervisor' AND model LIKE '%local%'`);
console.log(`  本地引擎标记的调用: ${fb.n}`);
const models = q(`SELECT model, COUNT(*) n FROM llm_usage GROUP BY model ORDER BY n DESC`);
for (const m of models) console.log(`  ${m.model.padEnd(24)} ${m.n}`);

console.log("\n═══ ⑩ 数据量增长 ═══");
for (const t of ["sessions", "llm_usage", "tool_calls", "event_log", "session_timings"]) {
  const c = one(`SELECT COUNT(*) c FROM ${t}`);
  console.log(`  ${t.padEnd(16)} ${String(c.c).padStart(7)} 行`);
}
db.close();
