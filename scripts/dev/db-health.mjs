import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log("=== ① 会话状态分布 ===");
for (const r of q("SELECT status, COUNT(*) n FROM sessions GROUP BY status")) {
  console.log(`  ${r.status}: ${r.n}`);
}

console.log("\n=== ② token 消耗分布 ===");
const t = q(`SELECT
  COUNT(*) n,
  ROUND(AVG(prompt_tokens + completion_tokens)) avg,
  MIN(prompt_tokens + completion_tokens) min,
  MAX(prompt_tokens + completion_tokens) max,
  SUM(CASE WHEN prompt_tokens + completion_tokens > 100000 THEN 1 ELSE 0 END) over100k
  FROM llm_usage WHERE ok = 1`);
console.log(`  样本 ${t[0].n} · 均值 ${t[0].avg} · 最小 ${t[0].min} · 最大 ${t[0].max} · 超 10 万 token 的调用 ${t[0].over100k}`);

console.log("\n=== ③ 按 agent 拆分的耗时 ===");
for (const r of q(`SELECT agent, COUNT(*) n, ROUND(AVG(duration_ms)) avg, MAX(duration_ms) max
  FROM llm_usage WHERE ok = 1 GROUP BY agent ORDER BY avg DESC`)) {
  console.log(`  ${r.agent.padEnd(12)} n=${String(r.n).padStart(4)} 平均 ${String(r.avg).padStart(6)}ms 峰值 ${r.max}ms`);
}

console.log("\n=== ④ 每场占卜的 LLM 调用次数（找异常放大）===");
for (const r of q(`SELECT s.id, s.status, COUNT(l.id) calls, ROUND(SUM(l.prompt_tokens+l.completion_tokens)) tok
  FROM sessions s JOIN llm_usage l ON l.session_id = s.id
  GROUP BY s.id HAVING calls > 12 ORDER BY calls DESC LIMIT 8`)) {
  console.log(`  ${r.id} ${r.status.padEnd(8)} ${r.calls} 次调用 / ${r.tok} token`);
}

console.log("\n=== ⑤ 工具调用频次 ===");
for (const r of q(`SELECT tool, COUNT(*) n, ROUND(AVG(duration_ms)) avg
  FROM tool_calls GROUP BY tool ORDER BY n DESC`)) {
  console.log(`  ${r.tool.padEnd(24)} ${String(r.n).padStart(4)} 次  平均 ${r.avg ?? "-"}ms`);
}

console.log("\n=== ⑥ 错误会话归因 ===");
for (const r of q(`SELECT error_reason, COUNT(*) n FROM sessions
  WHERE error_reason IS NOT NULL AND error_reason != '' GROUP BY error_reason ORDER BY n DESC`)) {
  console.log(`  ${String(r.error_reason).padEnd(24)} ${r.n}`);
}

console.log("\n=== ⑦ 表行数 ===");
for (const r of q(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)) {
  try {
    const c = db.prepare(`SELECT COUNT(*) n FROM "${r.name}"`).get();
    console.log(`  ${r.name.padEnd(20)} ${c.n}`);
  } catch { /* ignore */ }
}

console.log("\n=== ⑧ 索引情况 ===");
for (const r of q(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`)) {
  console.log(`  ${r.tbl_name}.${r.name}`);
}

console.log("\n=== ⑨ 事件日志总量与单场均值 ===");
const e = db.prepare("SELECT COUNT(*) n FROM event_log").get();
const es = db.prepare("SELECT AVG(c) avg FROM (SELECT COUNT(*) c FROM event_log GROUP BY session_id)").get();
console.log(`  event_log 共 ${e.n} 条 · 单场均值 ${es.avg?.toFixed(1)} 条`);
