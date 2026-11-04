/**
 * 验证：tool 结果是否重复了 tool_calls.arguments 里的内容（诊断工具，无断言）
 * 如果重复 → 同一份正文被传输两次，是纯粹的 token 浪费。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

const rows = db.prepare(`
  SELECT id, state_json FROM sessions
  WHERE status='done' AND state_json != '' AND length(state_json) > 5000
  ORDER BY created_at DESC LIMIT 20
`).all();

/** 找出每个 tool 消息对应的 tool_call_id 及其 arguments */
for (const r of rows) {
  const snap = JSON.parse(r.state_json);
  const msgs = snap.messages || [];
  if (msgs.length < 20) continue;

  const argsById = new Map();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    for (const t of m.tool_calls ?? []) {
      argsById.set(t.id, { name: t.function.name, args: t.function.arguments ?? "" });
    }
  }

  console.log(`═══ 会话 ${r.id.slice(0, 16)} ═══`);
  let dupChars = 0, totalChars = 0;
  for (const m of msgs) {
    if (m.role !== "tool") continue;
    const c = typeof m.content === "string" ? m.content : "";
    const meta = argsById.get(m.tool_call_id);
    if (!meta) continue;
    totalChars += c.length;

    // ⚠️ 判断：tool 结果里有多少内容与 arguments 重复
    let overlap = 0;
    try {
      const o = JSON.parse(meta.args);
      for (const [k, v] of Object.entries(o)) {
        if (typeof v !== "string" || v.length < 20) continue;
        if (c.includes(v.slice(0, 40))) overlap += v.length;
      }
    } catch { /* 非 JSON */ }

    const pct = c.length > 0 ? Math.round((overlap / c.length) * 100) : 0;
    dupChars += overlap;
    console.log(
      `  ${meta.name.padEnd(20)} args=${String(meta.args.length).padStart(4)}字  tool结果=${String(c.length).padStart(4)}字  重复=${String(overlap).padStart(4)}字 (${pct}%)`
    );
    if (pct > 30) {
      console.log(`      ⚠️ 高度重复！tool 结果前 120 字：${c.slice(0, 120).replace(/\n/g, " ⏎ ")}`);
    }
  }
  console.log(`  → tool 结果总 ${totalChars} 字，其中与 arguments 重复 ${dupChars} 字（${Math.round((dupChars / Math.max(1, totalChars)) * 100)}%）`);
  console.log();
  break;
}

db.close();
