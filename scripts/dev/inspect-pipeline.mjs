import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log("=== ① 走到 write_reading 的会话数（tool_calls 有 write_reading）===");
const w = q(`SELECT COUNT(DISTINCT session_id) n FROM tool_calls WHERE tool='write_reading'`);
console.log(`  ${w[0].n} 场`);

console.log("\n=== ② 各会话的工具调用链（看断在哪一步）===");
const sessions = q(`SELECT id, status, error_reason, cards_json, review_json FROM sessions ORDER BY created_at DESC LIMIT 12`);
for (const s of sessions) {
  const tools = q(`SELECT DISTINCT tool FROM tool_calls WHERE session_id=?`, s.id).map((x) => x.tool);
  const has = (t) => tools.includes(t);
  const stage = !has("establish_contract") ? "承约前"
    : !has("invoke_three_questions") ? "承约后(呼召前)"
    : !has("offer_card_selection") && !has("draw_cards") ? "呼召后(选牌前)"
    : !has("reveal_card") ? "选牌后(翻牌前)"
    : !has("interpret_card") ? "翻牌后(未解读)"
    : !has("write_reading") ? "解读后(未综合)"
    : !has("close_reading") ? "综合后(未收束)" : "完整";
  const rv = s.review_json;
  const rvKind = !rv || rv === "null" ? "NULL"
    : rv.includes("审校解析失败") ? "解析失败→默认通过"
    : rv.includes('"pass":true') ? "pass" : "fail";
  console.log(`  ${s.id} ${String(s.status).padEnd(6)} ${String(s.error_reason ?? "-").padEnd(18)} 阶段=${stage.padEnd(16)} 审校=${rvKind}`);
}

console.log("\n=== ③ review_json 形态分布 ===");
const all = q("SELECT review_json FROM sessions WHERE status='done'");
const kinds = {};
for (const r of all) {
  const j = r.review_json;
  const k = !j ? "字段为NULL"
    : j === "null" ? "字符串'null'"
    : j.includes("审校解析失败") ? "解析失败→默认通过"
    : j.includes('"pass":true') ? "真实pass=true"
    : j.includes('"pass":false') ? "真实pass=false"
    : "其它";
  kinds[k] = (kinds[k] ?? 0) + 1;
}
for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${n} 场（${((n / Math.max(1, all.length)) * 100).toFixed(1)}%）`);
}

console.log("\n=== ④ done 会话里有多少走了 write_reading ===");
const done = q("SELECT id FROM sessions WHERE status='done'");
let withWrite = 0;
for (const s of done) {
  const c = db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE session_id=? AND tool='write_reading'").get(s.id);
  if (c.n > 0) withWrite++;
}
console.log(`  done 会话 ${done.length} 场 · 其中走过 write_reading ${withWrite} 场（${((withWrite / Math.max(1, done.length)) * 100).toFixed(1)}%）`);
