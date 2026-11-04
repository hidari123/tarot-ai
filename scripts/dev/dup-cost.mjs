/**
 * 量化"tool 结果重复 arguments"的累积 token 浪费（诊断工具，无断言）
 * 关键：prompt 是累积的 —— 第 k 轮省 d 字，后续每一轮都省 d 字。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

const rows = db.prepare(`
  SELECT id, state_json FROM sessions
  WHERE status='done' AND state_json != '' AND length(state_json) > 5000
  ORDER BY created_at DESC LIMIT 30
`).all();

console.log("═══ 单场：重复内容的累积影响 ═══\n");

let sumSaving = 0, sumPrompt = 0, n = 0;
for (const r of rows) {
  const snap = JSON.parse(r.state_json);
  const msgs = snap.messages || [];
  if (msgs.length < 15) continue;

  const argsById = new Map();
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    for (const t of m.tool_calls ?? []) {
      argsById.set(t.id, { name: t.function.name, args: t.function.arguments ?? "" });
    }
  }

  // 找出 tool 消息在 messages 数组中的位置（第几轮）
  const toolPos = [];
  let toolIdx = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "tool") continue;
    toolIdx++;
    const meta = argsById.get(msgs[i].tool_call_id);
    if (!meta) { toolPos.push({ idx: toolIdx, saved: 0 }); continue; }
    let overlap = 0;
    try {
      const o = JSON.parse(meta.args);
      const c = typeof msgs[i].content === "string" ? msgs[i].content : "";
      for (const [k, v] of Object.entries(o)) {
        if (typeof v !== "string" || v.length < 20) continue;
        if (c.includes(v.slice(0, 40))) overlap += v.length;
      }
    } catch { /* ignore */ }
    toolPos.push({ idx: toolIdx, saved: overlap });
  }

  const totalRounds = toolPos.length;
  // ⚠️ 累积：第 k 轮省 d 字 → 后面 (totalRounds - k) 轮各省 d
  let saving = 0;
  for (const t of toolPos) saving += t.saved * (totalRounds - t.idx + 1);

  // 当前 prompt 总量（估算）
  let promptChars = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    promptChars += c.length;
    for (const t of m.tool_calls ?? []) promptChars += (t.function.arguments?.length ?? 0);
  }

  sumSaving += saving;
  sumPrompt += promptChars;
  n++;
  if (n <= 3) {
    console.log(`  ${r.id.slice(0, 14)}: ${totalRounds} 轮 · 当前 prompt 累计 ${promptChars} 字`);
    console.log(`    各轮可省：${toolPos.filter((t) => t.saved > 0).map((t) => `#${t.idx}(${t.saved})`).join(" ")}`);
    console.log(`    → 累积节省 ${saving} 字 = ${Math.round(saving / 2.5)} tokens（占该场 ${((saving / promptChars) * 100).toFixed(0)}%）`);
  }
}

if (n > 0) {
  console.log(`\n═══ 汇总（${n} 场）═══`);
  console.log(`  平均 prompt 累计 ${Math.round(sumPrompt / n)} 字`);
  console.log(`  平均可省 ${Math.round(sumSaving / n)} 字 = ${Math.round(sumSaving / n / 2.5)} tokens`);
  console.log(`  → 相当于单场 supervisor 消耗（25046 tokens）省 ${((sumSaving / n / 2.5) / 25046 * 100).toFixed(1)}%`);
  console.log(`  → 全库 295 场 done 会话，理论上可省 ${Math.round((sumSaving / n) * 295 / 2.5).toLocaleString()} tokens`);
}

db.close();
