#!/usr/bin/env node
/**
 * 诊断：验证**最近一场**占卜的新链路（快照剥离 + 消息完整性 + seq 续号）
 */
import Database from "better-sqlite3";

const db = new Database("data/tarot.db", { readonly: true });

const row = db
  .prepare("SELECT id, state_json, status FROM sessions ORDER BY created_at DESC LIMIT 1")
  .get();

console.log("=== 最近一场会话 ===");
console.log(`id: ${row.id}`);
console.log(`status: ${row.status}`);
console.log(`state_json 体积: ${row.state_json.length} B`);

const snap = JSON.parse(row.state_json);
const inState = Array.isArray(snap.messages) ? snap.messages.length : "not-array";
const inTable = db
  .prepare("SELECT COUNT(*) c FROM session_messages WHERE session_id = ?")
  .get(row.id).c;

console.log(`\n=== messages 剥离校验 ===`);
console.log(`  state_json 内: ${inState} 条（应为 0）`);
console.log(`  session_messages 表: ${inTable} 条（应 > 0）`);
console.log(`  状态字段: ${Object.keys(snap).length} 个`);
console.log(`  关键字段: ${["drawnCards", "cardReadings", "ragHits", "ritualPhase", "reading"]
  .map((k) => `${k}=${Array.isArray(snap[k]) ? snap[k].length : snap[k] ? "有" : "无"}`)
  .join(", ")}`);

// 消息内容完整性：逐条可解析 + 角色分布
const msgs = db
  .prepare("SELECT idx, msg_json FROM session_messages WHERE session_id = ? ORDER BY idx")
  .all(row.id);
const roles = {};
let bad = 0;
for (const m of msgs) {
  try {
    const o = JSON.parse(m.msg_json);
    roles[o.role] = (roles[o.role] ?? 0) + 1;
  } catch {
    bad++;
  }
}
console.log(`\n=== 消息完整性 ===`);
console.log(`  共 ${msgs.length} 条，解析失败 ${bad} 条`);
console.log(`  角色分布: ${Object.entries(roles).map(([r, c]) => `${r}=${c}`).join(", ")}`);

// ⚠️ 协议配对校验：assistant(tool_calls) 必须紧跟对应 tool 消息
const parsed = msgs.map((m) => JSON.parse(m.msg_json));
let pairErr = 0;
for (let i = 0; i < parsed.length; i++) {
  if (parsed[i].role !== "assistant" || !parsed[i].tool_calls) continue;
  for (const tc of parsed[i].tool_calls) {
    const next = parsed[i + 1];
    if (!next || next.role !== "tool" || next.tool_call_id !== tc.id) pairErr++;
  }
}
console.log(`\n=== 协议配对（assistant→tool）===\n  错位: ${pairErr} 处（应为 0）`);

// seq 续号校验
const maxSeq = db
  .prepare("SELECT MAX(seq) m FROM event_log WHERE session_id = ?")
  .get(row.id).m;
console.log(`\n=== event_log ===\n  最大 seq: ${maxSeq}`);

db.close();
