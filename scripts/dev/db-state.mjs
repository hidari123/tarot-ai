#!/usr/bin/env node
/**
 * 诊断：数据库现状（表行数 / 快照体积 / 消息占比）
 *
 * ⚠️ 用法：npx tsx scripts/dev/db-state.mjs
 * ⚠️ 无断言、用完即弃、不进 CI（与本目录其他脚本一致）。
 */
import Database from "better-sqlite3";

const db = new Database("data/tarot.db", { readonly: true });

console.log("=== 表行数 ===");
for (const t of ["sessions", "tool_calls", "llm_usage", "event_log", "session_timings", "user_profiles"]) {
  try {
    console.log(`${t.padEnd(18)} ${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`);
  } catch (e) {
    console.log(`${t.padEnd(18)} ERR ${e.message}`);
  }
}

console.log("\n=== 索引检查 ===");
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'").all();
console.log("sessions 索引:", idx.map((r) => r.name).join(", "));
console.log("含 share_token 索引:", idx.some((r) => r.name.includes("share_token")));

console.log("\n=== state_json 体积 ===");
try {
  const r = db
    .prepare("SELECT AVG(LENGTH(state_json)) a, MAX(LENGTH(state_json)) m, COUNT(*) c FROM sessions WHERE state_json != ''")
    .get();
  console.log(`平均 ${Math.round(r.a || 0)} 字节 · 最大 ${r.m || 0} 字节 · ${r.c} 场有快照`);
} catch (e) {
  console.log("ERR", e.message);
}

console.log("\n=== 快照里 messages 占多少 ===");
try {
  const rows = db.prepare("SELECT state_json FROM sessions WHERE state_json != '' LIMIT 200").all();
  let total = 0, msgTotal = 0, counts = [];
  for (const r of rows) {
    const s = JSON.parse(r.state_json);
    const t = JSON.stringify(s).length;
    const m = JSON.stringify(s.messages ?? []).length;
    total += t;
    msgTotal += m;
    counts.push(s.messages?.length ?? 0);
  }
  const n = rows.length || 1;
  console.log(`样本 ${n} 场 · 平均快照 ${Math.round(total / n)} 字节 · messages 占 ${((msgTotal / total) * 100).toFixed(1)}%`);
  console.log(`messages 平均条数 ${(counts.reduce((a, b) => a + b, 0) / n).toFixed(1)} · 最多 ${Math.max(...counts, 0)} 条`);
} catch (e) {
  console.log("ERR", e.message);
}

console.log("\n=== 脏数据检查（cards_json 能否解析） ===");
try {
  const rows = db.prepare("SELECT cards_json FROM sessions").all();
  let bad = 0;
  for (const r of rows) {
    try { JSON.parse(r.cards_json); } catch { bad++; }
  }
  console.log(`共 ${rows.length} 场，解析失败 ${bad} 场`);
} catch (e) {
  console.log("ERR", e.message);
}

db.close();
