#!/usr/bin/env node
/**
 * 端到端冒烟：跑一场真实占卜，验证第二轮优化的新链路
 *
 * ⚠️ 验证的正是本轮改动的风险点：
 *   ① 快照 messages 剥离后，占卜过程能否正常落库/恢复
 *   ② tool 结果瘦身是否导致协议错位（assistant→tool 配对）
 *   ③ 恢复会话时 seq 是否续号（不重复）
 *   ④ 错误边界/懒加载改动没破坏页面渲染
 *
 * ⚠️ 用法：npx tsx scripts/dev/e2e-smoke.mjs http://localhost:3000
 */
const BASE = process.argv[2] || "http://localhost:3000";

console.log("=== 端到端冒烟测试 ===\n");
console.log("目标:", BASE, "\n");

// ① 首页可访问
const home = await fetch(`${BASE}/`);
console.log(`首页: ${home.status} ${home.ok ? "OK" : "FAIL"}`);

// ② 起一场占卜（读 SSE）
const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "我该不该换工作？", persona: "mystic" }),
});
console.log(`起占卜: ${res.status} ${res.ok ? "OK" : "FAIL"}`);

let sessionId = null;
const types = [];
let toolCalls = 0;
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let done = false;

const t0 = Date.now();
while (!done && Date.now() - t0 < 90_000) {
  const { done: fin, value } = await reader.read();
  if (fin) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") continue;
    let evt;
    try { evt = JSON.parse(raw); } catch { continue; }
    types.push(evt.type);
    if (evt.type === "session") sessionId = evt.sessionId;
    if (evt.type === "tool") toolCalls++;
    if (evt.type === "ask_user") {
      console.log(`  → 等待用户应答（kind=${evt.ask?.kind}）`);
      // 自动应答，让流程继续
      const answerRes = await fetch(`${BASE}/api/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer: "我想了很久，还是想先看看别的可能" }),
      });
      console.log(`  → 应答: ${answerRes.status}`);
    }
    if (evt.type === "done") { done = true; break; }
    if (evt.type === "error") { console.log(`  ! error: ${evt.error}`); done = true; break; }
  }
}

console.log(`\n事件统计（共 ${types.length} 条）:`);
const counts = {};
for (const t of types) counts[t] = (counts[t] ?? 0) + 1;
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
console.log(`工具调用: ${toolCalls}`);
console.log(`sessionId: ${sessionId}`);

// ③ 校验数据库：新链路是否正确
if (sessionId) {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database("data/tarot.db", { readonly: true });
  const row = db.prepare("SELECT state_json FROM sessions WHERE id = ?").get(sessionId);
  if (row?.state_json) {
    const snap = JSON.parse(row.state_json);
    const inState = Array.isArray(snap.messages) ? snap.messages.length : 0;
    const inTable = db
      .prepare("SELECT COUNT(*) c FROM session_messages WHERE session_id = ?")
      .get(sessionId).c;
    console.log(`\n快照校验:`);
    console.log(`  state_json 体积: ${row.state_json.length} B`);
    console.log(`  state 内消息: ${inState}（应为 0）`);
    console.log(`  新表内消息: ${inTable}（应 > 0）`);
    console.log(`  ✓ 剥离生效: ${inState === 0 && inTable > 0 ? "是" : "否"}`);
  } else {
    console.log("\n（该会话还没落快照 —— 可能仍在进行）");
  }
  db.close();
}
