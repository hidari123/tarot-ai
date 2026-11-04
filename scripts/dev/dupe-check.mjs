#!/usr/bin/env node
/**
 * 诊断：检查 sessions 表里是否存在重复 id，以及未迁移的会话
 */
import Database from "better-sqlite3";

const db = new Database("data/tarot.db", { readonly: true });

console.log("=== sessions 表重复 id 检查 ===");
const dupes = db
  .prepare("SELECT id, COUNT(*) c FROM sessions GROUP BY id HAVING c > 1 LIMIT 5")
  .all();
console.log(`重复 id 组数（抽样前5）: ${dupes.length}`);
for (const d of dupes) {
  console.log(`  ${d.id} × ${d.c}`);
}
const totalDupe = db
  .prepare("SELECT COUNT(*) c FROM (SELECT id FROM sessions GROUP BY id HAVING COUNT(*) > 1)")
  .get().c;
console.log(`重复 id 组总数: ${totalDupe}`);

console.log("\n=== 未迁移的会话（看实际内容） ===");
const rows = db
  .prepare("SELECT id, state_json FROM sessions WHERE state_json LIKE '%\"messages\"%' LIMIT 5")
  .all();
for (const r of rows) {
  let msgs = null;
  try {
    const s = JSON.parse(r.state_json);
    msgs = Array.isArray(s.messages) ? s.messages.length : "not-array";
  } catch {
    msgs = "parse-fail";
  }
  console.log(`  ${r.id.slice(0, 14)} messages 条数=${msgs}`);
}

db.close();
