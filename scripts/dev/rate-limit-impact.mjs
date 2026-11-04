/**
 * 诊断：限流对用户的**实际感知**（无断言）
 * ⚠️ 用户的诉求："别让用户感知到限流" → 需要量化：
 *    ① 限流等待占单场占卜时间的比例
 *    ② 用户能"看见"的等待有多长（>1s 的等待才会被感知）
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

console.log("═══ ① supervisor 单次调用耗时分布（限流等待会体现在这里）═══");
const rows = db.prepare(`
  SELECT duration_ms FROM llm_usage WHERE agent='supervisor' AND ok=1 AND duration_ms > 0
`).all().map((r) => r.duration_ms).sort((a, b) => a - b);
const pct = (p) => rows[Math.floor(rows.length * p)];
console.log(`  样本 ${rows.length}`);
console.log(`  中位 ${pct(0.5)}ms · P75 ${pct(0.75)}ms · P90 ${pct(0.9)}ms · P95 ${pct(0.95)}ms · P99 ${pct(0.99)}ms`);
console.log(`  >3s:  ${rows.filter((d) => d > 3000).length} (${((rows.filter((d) => d > 3000).length / rows.length) * 100).toFixed(1)}%)`);
console.log(`  >10s: ${rows.filter((d) => d > 10000).length} (${((rows.filter((d) => d > 10000).length / rows.length) * 100).toFixed(1)}%)`);

console.log("\n═══ ② 单场占卜的总耗时 & 长调用占比 ═══");
const sess = db.prepare(`
  SELECT u.session_id, SUM(u.duration_ms) total, COUNT(*) calls,
         SUM(CASE WHEN u.duration_ms > 8000 THEN u.duration_ms ELSE 0 END) slowMs,
         SUM(CASE WHEN u.duration_ms > 8000 THEN 1 ELSE 0 END) slowCalls
  FROM llm_usage u WHERE u.agent='supervisor' AND u.ok=1
  GROUP BY u.session_id HAVING calls >= 8
`).all();
if (sess.length) {
  const totals = sess.map((s) => s.total).sort((a, b) => a - b);
  const slowShare = sess.map((s) => (s.slowMs / s.total) * 100).sort((a, b) => a - b);
  const avgCalls = sess.reduce((a, s) => a + s.calls, 0) / sess.length;
  console.log(`  样本 ${sess.length} 场 · 平均 ${avgCalls.toFixed(1)} 次调用`);
  console.log(`  单场总耗时中位 ${(totals[Math.floor(totals.length / 2)] / 1000).toFixed(1)}s · P90 ${(totals[Math.floor(totals.length * 0.9)] / 1000).toFixed(1)}s`);
  console.log(`  长调用(>8s)占单场耗时比例：中位 ${slowShare[Math.floor(slowShare.length / 2)].toFixed(1)}% · P90 ${slowShare[Math.floor(slowShare.length * 0.9)].toFixed(1)}%`);
  console.log(`  → 平均每场有 ${(sess.reduce((a, s) => a + s.slowCalls, 0) / sess.length).toFixed(1)} 次调用超过 8 秒`);
  console.log(`  ⚠️ 这些"长尾"如果大部分是限流等待 → 用户能感知到（>8s 一定是感知的）`);
}

console.log("\n═══ ③ 有多少长调用是「限流等待」而非「模型慢」？═══");
console.log("  ⚠️ 判据：限流等待的特征 = duration 接近整秒的整数倍（sleep 的结果）");
console.log("     而模型慢 = duration 是连续的、非整秒值。");
const longCalls = db.prepare(`
  SELECT duration_ms, prompt_tokens, completion_tokens FROM llm_usage
  WHERE agent='supervisor' AND ok=1 AND duration_ms > 8000
`).all();
const nearInteger = longCalls.filter((r) => Math.abs(r.duration_ms - Math.round(r.duration_ms / 1000) * 1000) < 120).length;
console.log(`  长调用总数 ${longCalls.length}`);
console.log(`  接近整秒（疑似 sleep 等待）: ${nearInteger} (${((nearInteger / Math.max(1, longCalls.length)) * 100).toFixed(1)}%)`);
console.log(`  → 这是**上界**（模型耗时本身也可能凑巧接近整秒）`);

console.log("\n═══ ④ 429 实际发生过吗 ═══");
const fails = db.prepare(`SELECT COUNT(*) c FROM llm_usage WHERE ok=0`).get().c;
console.log(`  失败调用 ${fails} 次 / 总 ${db.prepare("SELECT COUNT(*) c FROM llm_usage").get().c}`);
const models = db.prepare(`SELECT model, COUNT(*) n, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) f FROM llm_usage GROUP BY model`).all();
for (const m of models) {
  console.log(`  ${m.model.padEnd(22)} ${m.n} 次调用 · 失败 ${m.f} (${((m.f / m.n) * 100).toFixed(1)}%)`);
}

db.close();
