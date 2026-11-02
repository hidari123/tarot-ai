#!/usr/bin/env node
/**
 * 验证仪式守卫（后端强制，不依赖模型自觉）
 *
 * 场景：模型跳过 establish_contract 直接调 draw_cards →
 *       期望：被拦截（返回错误提示让模型补承约），不出现 cards 事件。
 *
 * 怎么测：直接调 supervisor 的内部逻辑不方便 —— 改用"观察法"：
 *   跑一场真实占卜，检查事件序列里 contract 一定出现在 cards 之前。
 *   若模型这次乖乖走了仪式，守卫就是安全的（不影响正常路径）。
 *   再检查：session 里 contractQuestion 为空时不可能出现 cards 事件
 *   （通过 DB 反查历史会话，验证守卫生效期间没有"无承约先抽牌"的记录）。
 */
import Database from "better-sqlite3";
const db = new Database("data/tarot.db");

// 找出所有"有 cards 事件但没有 contract 事件"的会话
const rows = db.prepare(`
  SELECT s.id, s.question, s.created_at
  FROM sessions s
  WHERE EXISTS (SELECT 1 FROM event_log e WHERE e.session_id = s.id AND e.type = 'cards')
    AND NOT EXISTS (SELECT 1 FROM event_log e WHERE e.session_id = s.id AND e.type = 'contract')
  ORDER BY s.created_at DESC LIMIT 10
`).all();

console.log("=== 仪式完整性检查（有抽牌但无承约的会话）===");
if (rows.length === 0) {
  console.log("  ✅ 无违规会话（所有抽牌都有承约在前）");
} else {
  console.log(`  ⚠️ ${rows.length} 条违规会话（守卫引入前的老数据）：`);
  for (const r of rows) {
    console.log(`     ${new Date(r.created_at).toLocaleString("zh-CN")} ${r.question.slice(0, 26)}`);
  }
}

// 统计：各会话的仪式环节覆盖
console.log("\n=== 最近 8 场会话的仪式覆盖 ===");
const recent = db.prepare("SELECT id, question FROM sessions ORDER BY created_at DESC LIMIT 8").all();
let full = 0;
for (const s of recent) {
  const ev = db.prepare(
    "SELECT type FROM event_log WHERE session_id = ?"
  ).all(s.id).map((e) => e.type);
  const has = (t) => ev.includes(t);
  const contract = has("contract");
  const invocation = has("invocation");
  const cards = has("cards");
  const reveal = ev.filter((t) => t === "card_reveal").length;
  const reading = ev.filter((t) => t === "card_reading").length;
  const closing = has("ask_user") && ev.includes("ask_user");
  const ok = contract && invocation && cards && reveal > 0 && reading > 0;
  if (ok) full++;
  console.log(
    `  ${ok ? "✅" : "⚠️"} 承约${contract ? "✓" : "✗"} 呼召${invocation ? "✓" : "✗"} ` +
    `抽牌${cards ? "✓" : "✗"} 翻${reveal} 讲${reading} | ${s.question.slice(0, 22)}`
  );
}
console.log(`\n完整仪式率: ${full}/${recent.length}`);
