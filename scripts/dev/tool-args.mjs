/**
 * 查看模型实际传给工具的参数（诊断工具，无断言）
 * 目的：确认 tool_calls.arguments 里到底带了什么（为什么占 prompt 的 43%）
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

const rows = db.prepare(`
  SELECT id, state_json FROM sessions
  WHERE status='done' AND state_json != '' AND length(state_json) > 5000
  ORDER BY created_at DESC LIMIT 20
`).all();

for (const r of rows) {
  const snap = JSON.parse(r.state_json);
  const msgs = snap.messages || [];
  if (msgs.length < 20) continue;

  console.log(`═══ 会话 ${r.id.slice(0, 16)} ═══`);
  for (const m of msgs) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const t of m.tool_calls) {
      const args = t.function.arguments ?? "";
      if (args.length < 200) continue;
      console.log(`  ${t.function.name} (${args.length} 字):`);
      try {
        const o = JSON.parse(args);
        for (const [k, v] of Object.entries(o)) {
          const s = typeof v === "string" ? v : JSON.stringify(v);
          console.log(`      ${k.padEnd(16)} ${String(s.length).padStart(5)} 字  ${s.slice(0, 90).replace(/\n/g, " ⏎ ")}`);
        }
      } catch {
        console.log(`      (非 JSON) ${args.slice(0, 120)}`);
      }
    }
  }
  console.log();
  break;
}

db.close();
