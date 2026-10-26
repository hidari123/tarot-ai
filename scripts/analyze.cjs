/** 项目现状分析：token 分布、审校失败率、会话终态 */
const Database = require("better-sqlite3");
const db = new Database("data/tarot.db", { readonly: true });

console.log("=== 最近 12 次 LLM 调用（看上下文膨胀）===");
const u = db.prepare(`SELECT agent, prompt_tokens pt, completion_tokens ct, duration_ms ms, ok
                      FROM llm_usage ORDER BY id DESC LIMIT 12`).all();
for (const x of u) {
  console.log(`  ${x.agent.padEnd(11)} ptok=${String(x.pt).padStart(6)} ctok=${String(x.ct).padStart(6)} ${String(x.ms).padStart(6)}ms ok=${x.ok}`);
}

console.log("\n=== 各 Agent 平均 token / 平均耗时 ===");
const agg = db.prepare(`SELECT agent, COUNT(*) n, AVG(prompt_tokens) pt, AVG(completion_tokens) ct, AVG(duration_ms) ms
                        FROM llm_usage GROUP BY agent`).all();
for (const a of agg) {
  console.log(`  ${a.agent.padEnd(11)} ${String(a.n).padStart(3)}次  ptok=${Math.round(a.pt)}  ctok=${Math.round(a.ct)}  ${Math.round(a.ms)}ms`);
}

console.log("\n=== 审校 JSON 解析失败率 ===");
const rv = db.prepare(`SELECT review_json FROM sessions WHERE review_json != 'null'`).all();
const fail = rv.filter((r) => r.review_json.includes("解析失败")).length;
console.log(`  ${fail} / ${rv.length} 次审校解析失败`);

console.log("\n=== 会话终态分布 ===");
const st = db.prepare(`SELECT status, COUNT(*) c FROM sessions GROUP BY status`).all();
for (const s of st) console.log(`  ${s.status.padEnd(10)} ${s.c}`);

console.log("\n=== 解读字数分布 ===");
const lens = db.prepare(`SELECT length(reading) len FROM sessions WHERE length(reading) > 0`).all();
if (lens.length) {
  const arr = lens.map((l) => l.len).sort((a, b) => a - b);
  console.log(`  n=${arr.length}  最小=${arr[0]}  中位=${arr[Math.floor(arr.length / 2)]}  最大=${arr[arr.length - 1]}`);
}

console.log("\n=== 工具调用频次（真实 Agent 路径）===");
const tc = db.prepare(`SELECT tool, COUNT(*) c FROM tool_calls GROUP BY tool ORDER BY c DESC`).all();
for (const t of tc) console.log(`  ${t.tool.padEnd(22)} ${t.c}`);

console.log("\n=== 每次会话的工具调用次数分布 ===");
const per = db.prepare(`SELECT session_id, COUNT(*) c FROM tool_calls GROUP BY session_id`).all();
if (per.length) {
  const arr = per.map((p) => p.c).sort((a, b) => a - b);
  console.log(`  n=${arr.length}  最小=${arr[0]}  中位=${arr[Math.floor(arr.length / 2)]}  最大=${arr[arr.length - 1]}`);
}
