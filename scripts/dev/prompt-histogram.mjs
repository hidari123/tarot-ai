/**
 * 深挖：supervisor 的 prompt token 分布（诊断工具，无断言）
 * 异常现象：平均 4050 tokens，但"末个 prompt"只有 100 —— 增长 0.1×
 * 可能意味着：大量调用是**极短 prompt**（几乎没上下文）→ 记账错位 or 某条路径没带 messages
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log("═══ ① supervisor prompt token 的分桶分布 ═══");
const buckets = q(`
  SELECT
    CASE
      WHEN prompt_tokens < 200 THEN '<200'
      WHEN prompt_tokens < 500 THEN '200-500'
      WHEN prompt_tokens < 1000 THEN '500-1k'
      WHEN prompt_tokens < 2000 THEN '1k-2k'
      WHEN prompt_tokens < 4000 THEN '2k-4k'
      WHEN prompt_tokens < 8000 THEN '4k-8k'
      ELSE '8k+'
    END bucket,
    COUNT(*) n,
    SUM(prompt_tokens) total,
    ROUND(AVG(prompt_tokens)) avg,
    ROUND(AVG(completion_tokens)) avg_completion,
    ROUND(AVG(duration_ms)) avg_ms
  FROM llm_usage WHERE agent='supervisor'
  GROUP BY bucket ORDER BY MIN(prompt_tokens)
`);
for (const b of buckets) {
  console.log(`  ${b.bucket.padEnd(9)} ${String(b.n).padStart(5)} 次  prompt合计 ${String(b.total).padStart(9)}  均${String(b.avg).padStart(6)}  completion均${String(b.avg_completion).padStart(5)}  ${b.avg_ms}ms`);
}

console.log("\n═══ ② <200 tokens 的短 prompt 调用是什么？ ═══");
const short = q(`
  SELECT id, session_id, model, prompt_tokens, completion_tokens, duration_ms, ok, created_at
  FROM llm_usage WHERE agent='supervisor' AND prompt_tokens < 200
  ORDER BY id DESC LIMIT 5
`);
for (const r of short) {
  console.log(`  ${new Date(r.created_at).toISOString().slice(0, 16)} sess=${r.session_id.slice(0, 12)} model=${r.model} p=${r.prompt_tokens} c=${r.completion_tokens} ${r.duration_ms}ms ok=${r.ok}`);
}
console.log(`  → 短 prompt 调用总数: ${q("SELECT COUNT(*) c FROM llm_usage WHERE agent='supervisor' AND prompt_tokens < 200")[0].c}`);

console.log("\n═══ ③ 这些短调用属于哪些会话？会话最终状态？ ═══");
const shortSess = q(`
  SELECT s.status, s.error_reason, COUNT(DISTINCT u.session_id) n
  FROM llm_usage u JOIN sessions s ON s.id = u.session_id
  WHERE u.agent='supervisor' AND u.prompt_tokens < 200
  GROUP BY s.status, s.error_reason ORDER BY n DESC
`);
for (const r of shortSess) {
  console.log(`  ${r.status.padEnd(6)} ${(r.error_reason || "-").padEnd(20)} ${r.n} 场`);
}

console.log("\n═══ ④ 单场内的 supervisor prompt 序列（看是否有异常重复调用）═══");
const oneSess = q(`
  SELECT session_id, COUNT(*) n, ROUND(AVG(prompt_tokens)) avg_p,
         SUM(prompt_tokens) total
  FROM llm_usage WHERE agent='supervisor'
  GROUP BY session_id ORDER BY n DESC LIMIT 3
`);
for (const s of oneSess) {
  console.log(`  会话 ${s.session_id.slice(0, 14)}: ${s.n} 次 supervisor 调用 · 平均 prompt ${s.avg_p} · 合计 ${s.total}`);
  const seq = q(`SELECT prompt_tokens p, completion_tokens c, duration_ms d
    FROM llm_usage WHERE agent='supervisor' AND session_id=? ORDER BY id`, s.session_id);
  console.log(`    prompt 序列: ${seq.map((r) => r.p).join(" → ")}`);
  console.log(`    耗时序列(ms): ${seq.map((r) => r.d).join(" → ")}`);
}

console.log("\n═══ ⑤ 重复调用检测：同一 session 同一时刻的多次调用 ═══");
const dup = q(`
  SELECT COUNT(*) c FROM (
    SELECT session_id, created_at, COUNT(*) n FROM llm_usage
    WHERE agent='supervisor' GROUP BY session_id, created_at HAVING COUNT(*) > 1
  )`);
console.log(`  同一 session 同一毫秒多次 supervisor 调用: ${dup[0].c} 组`);

console.log("\n═══ ⑥ max_rounds 的会话：prompt 是否线性增长 ═══");
const mr = q(`
  SELECT u.session_id FROM llm_usage u JOIN sessions s ON s.id=u.session_id
  WHERE s.error_reason='max_rounds' LIMIT 1
`);
if (mr.length) {
  const seq = q(`SELECT prompt_tokens p, completion_tokens c FROM llm_usage
    WHERE agent='supervisor' AND session_id=? ORDER BY id`, mr[0].session_id);
  console.log(`  会话 ${mr[0].session_id.slice(0, 14)} 的 prompt 序列（${seq.length} 次）：`);
  console.log(`    ${seq.map((r) => r.p).join(" → ")}`);
}

db.close();
