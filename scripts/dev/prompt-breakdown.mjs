/**
 * 精确量化 supervisor prompt 的构成（诊断工具，无断言）
 *
 * ⚠️ 上一版脚本口径不可比（"累计"只算 content，"压缩后"算 content+arguments）。
 *    这一版统一口径：分别统计 content / tool_calls.arguments / system 三部分。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

// ⚠️ 相对路径基于**脚本所在目录**（scripts/dev/）→ ../../src
const { trimHistory } = await import("../../src/lib/agent/helpers.ts");

const rows = db.prepare(`
  SELECT id, state_json FROM sessions
  WHERE status='done' AND state_json != '' AND length(state_json) > 5000
  ORDER BY created_at DESC LIMIT 8
`).all();

/** 统计一段 messages 的各部分体积 */
function measure(msgs) {
  let sys = 0, user = 0, asstContent = 0, toolContent = 0, toolArgs = 0;
  let nToolArgs = 0;
  const perTool = new Map();
  for (const m of msgs) {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role === "system") sys += c.length;
    else if (m.role === "user") user += c.length;
    else if (m.role === "assistant") {
      asstContent += c.length;
      for (const t of m.tool_calls ?? []) {
        const len = (t.function.arguments?.length ?? 0);
        toolArgs += len;
        nToolArgs++;
        perTool.set(t.function.name, (perTool.get(t.function.name) ?? 0) + len);
      }
    } else if (m.role === "tool") toolContent += c.length;
  }
  return { sys, user, asstContent, toolContent, toolArgs, nToolArgs, perTool, total: sys + user + asstContent + toolContent + toolArgs };
}

console.log("═══ 单场占卜的 prompt 构成（未压缩 vs 压缩后）═══\n");
for (const r of rows) {
  const snap = JSON.parse(r.state_json);
  const msgs = snap.messages || [];
  if (msgs.length < 20) continue;

  const raw = measure(msgs);
  const trimmed = measure(trimHistory(msgs, 4));

  console.log(`会话 ${r.id.slice(0, 16)} · ${msgs.length} 条消息`);
  console.log("  部分              未压缩      压缩后     变化");
  const parts = [["system", "sys"], ["user 消息", "user"], ["assistant 正文", "asstContent"], ["tool 结果", "toolContent"], ["tool_calls 参数", "toolArgs"]];
  for (const [label, key] of parts) {
    const a = raw[key], b = trimmed[key];
    const chg = a > 0 ? `${(((b - a) / a) * 100).toFixed(0)}%` : "-";
    console.log(`  ${label.padEnd(16)} ${String(a).padStart(8)} ${String(b).padStart(10)}   ${chg.padStart(6)}`);
  }
  console.log(`  ${"合计".padEnd(16)} ${String(raw.total).padStart(8)} ${String(trimmed.total).padStart(10)}   ${(((trimmed.total - raw.total) / raw.total) * 100).toFixed(0)}%`);
  console.log(`  → token 估算：${Math.round(trimmed.total / 2.5)}（中文 2.5 字/token）`);
  console.log(`  → tool_calls 参数占了压缩后 prompt 的 ${((trimmed.toolArgs / trimmed.total) * 100).toFixed(1)}%（${trimmed.nToolArgs} 个调用）`);
  console.log(`  → 各工具的参数体积：`);
  for (const [k, v] of [...trimmed.perTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`      ${k.padEnd(24)} ${v} 字`);
  }
  console.log();
  break;
}

/* ═══ 全库统计：单场平均成本构成 ═══ */
console.log("═══ 全库：done 会话的平均 prompt token（从 llm_usage 取真实值）═══");
const stats = db.prepare(`
  SELECT ROUND(AVG(prompt_tokens)) avg_p, ROUND(AVG(completion_tokens)) avg_c, COUNT(*) n
  FROM llm_usage WHERE agent='supervisor' AND ok=1 AND prompt_tokens > 500
`).get();
console.log(`  supervisor 有效调用 ${stats.n} 次 · 平均 prompt ${stats.avg_p} + completion ${stats.avg_c} = ${stats.avg_p + stats.avg_c} tokens/次`);

const perSession = db.prepare(`
  SELECT AVG(t) avg_total FROM (
    SELECT SUM(prompt_tokens+completion_tokens) t FROM llm_usage WHERE agent='supervisor' GROUP BY session_id
  )
`).get();
console.log(`  平均每场 supervisor 总消耗 ${Math.round(perSession.avg_total)} tokens`);

console.log("\n═══ 估算：如果每轮只带最近 2 轮（而不是 4 轮）能省多少 ═══");
for (const keep of [4, 3, 2, 1]) {
  let saved = 0, total = 0;
  for (const r of rows.slice(0, 5)) {
    const snap = JSON.parse(r.state_json);
    const msgs = snap.messages || [];
    if (msgs.length < 10) continue;
    const a = measure(trimHistory(msgs, keep)).total;
    const b = measure(trimHistory(msgs, 4)).total;
    saved += b - a;
    total += b;
  }
  if (total > 0) {
    console.log(`  keep=${keep} 轮 → 平均 prompt ${Math.round(total / 5)} 字（比 keep=4 省 ${(100 - (total / Math.max(1, total + saved)) * 100).toFixed(1)}%）`);
  }
}

db.close();
