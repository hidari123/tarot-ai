/**
 * 深挖：prompt 每轮 +350 tokens 的增量来源（诊断工具，无断言）
 * 方法：找一个有完整快照的会话，逐步模拟 trimHistory 后的 prompt 规模。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

// ⚠️ trimHistory 在 helpers.ts（TS）—— 用 tsx 跑本脚本才能 import
const { trimHistory } = await import("../src/lib/agent/helpers.ts").catch(() => ({ trimHistory: null }));

const rows = db.prepare(`
  SELECT id, state_json FROM sessions
  WHERE status='done' AND state_json != '' AND length(state_json) > 5000
  ORDER BY created_at DESC LIMIT 5
`).all();

console.log(`候选会话（含快照）：${rows.length} 个\n`);

for (const r of rows) {
  const snap = JSON.parse(r.state_json);
  const msgs = snap.messages || [];
  if (msgs.length < 8) continue;

  console.log(`═══ 会话 ${r.id.slice(0, 16)} · messages ${msgs.length} 条 ═══`);

  // ⚠️ 逐轮模拟：每条 assistant 消息后，prompt 的规模
  let cum = 0;
  const rowsOut = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    cum += c.length;
    const trimmed = trimHistory ? trimHistory(msgs.slice(0, i + 1), 4) : msgs.slice(0, i + 1);
    const tlen = trimmed.reduce((s, x) => {
      const cc = typeof x.content === "string" ? x.content : JSON.stringify(x.content ?? "");
      const tc = (x.tool_calls ?? []).reduce((a, t) => a + (t.function.arguments?.length ?? 0), 0);
      return s + cc.length + tc;
    }, 0);
    rowsOut.push({
      i,
      role: m.role,
      len: c.length,
      cumRaw: cum,
      trimmed: tlen,
      tool: m.tool_calls?.map((t) => t.function.name).join(",") ?? "",
      preview: c.slice(0, 45).replace(/\n/g, " "),
    });
  }

  console.log("  轮  角色      本条长度   累计(原始)  压缩后prompt  工具");
  for (const x of rowsOut) {
    console.log(
      `  ${String(x.i).padStart(2)}  ${x.role.padEnd(9)} ${String(x.len).padStart(8)} ${String(x.cumRaw).padStart(11)} ${String(x.trimmed).padStart(12)}  ${x.tool}`
    );
  }

  const last = rowsOut[rowsOut.length - 1];
  console.log(`  → 压缩后最终 prompt ≈ ${last.trimmed} 字 ≈ ${Math.round(last.trimmed / 2.5)} tokens`);
  console.log(`  → 若无压缩会是 ${last.cumRaw} 字 ≈ ${Math.round(last.cumRaw / 2.5)} tokens`);
  if (trimHistory) {
    console.log(`  → 压缩节省 ${(100 - (last.trimmed / last.cumRaw) * 100).toFixed(0)}%`);
  } else {
    console.log(`  → ⚠️ 无法 import trimHistory（需 tsx 运行本脚本）`);
  }
  console.log();
  break;
}

db.close();
