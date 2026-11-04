#!/usr/bin/env node
/**
 * 诊断：验证 messages 剥离后，快照与新表的一致性
 *
 * ⚠️ 用法：npx tsx scripts/dev/snapshot-check.mjs
 */
import Database from "better-sqlite3";

const db = new Database("data/tarot.db", { readonly: true });

console.log("=== 抽样验证 messages 剥离的正确性 ===\n");

const rows = db
  .prepare("SELECT id, state_json FROM sessions WHERE state_json != '' LIMIT 8")
  .all();

for (const r of rows) {
  let snap;
  try {
    snap = JSON.parse(r.state_json);
  } catch {
    console.log(`${r.id.slice(0, 12)} — 快照损坏（跳过）`);
    continue;
  }
  const inState = Array.isArray(snap.messages) ? snap.messages.length : 0;
  const inTable = db
    .prepare("SELECT COUNT(*) c FROM session_messages WHERE session_id = ?")
    .get(r.id).c;
  const size = r.state_json.length;
  console.log(
    `${r.id.slice(0, 12)} — state_json ${String(size).padStart(6)}B | ` +
      `state内消息 ${String(inState).padStart(3)} | 新表内 ${String(inTable).padStart(3)} | ` +
      `状态字段 ${Object.keys(snap).length} 个`
  );
}

console.log("\n=== 完整性核对 ===");
const withMsgs = db
  .prepare("SELECT COUNT(*) c FROM sessions WHERE state_json LIKE '%\"messages\"%'")
  .get().c;
const sessionsWithMsgs = db
  .prepare("SELECT COUNT(DISTINCT session_id) c FROM session_messages")
  .get().c;
console.log(`state_json 里仍含 messages 的会话: ${withMsgs}（应为 0）`);
console.log(`新表里已有消息的会话数: ${sessionsWithMsgs}`);

// 抽样验证消息内容可完整还原
const sample = db
  .prepare("SELECT session_id FROM session_messages GROUP BY session_id LIMIT 1")
  .get();
if (sample) {
  const msgs = db
    .prepare("SELECT msg_json FROM session_messages WHERE session_id = ? ORDER BY idx")
    .all(sample.session_id);
  let ok = 0;
  for (const m of msgs) {
    try {
      const o = JSON.parse(m.msg_json);
      if (o && typeof o === "object") ok++;
    } catch {
      /* 坏数据 */
    }
  }
  console.log(`样本会话 ${sample.session_id.slice(0, 12)}: ${msgs.length} 条消息，${ok} 条可解析`);
}

db.close();
