#!/usr/bin/env node
/**
 * 验证：会话状态快照（P1-④）
 *
 * 1. 起一场占卜（跑到有状态为止）
 * 2. 检查 SQLite 里 sessions.state_json 有内容
 * 3. 模拟"进程重启"：清空内存会话表，从快照恢复
 * 4. 验证恢复出来的会话字段一致（问题/牌/进度）
 */
import Database from "better-sqlite3";

const BASE = process.argv[2] || "http://localhost:3000";
const db = new Database("data/tarot.db");

console.log("\n=== ① 起一场占卜 ===\n");
const ac = new AbortController();
setTimeout(() => ac.abort(), 180000);
const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "测试快照功能" }),
  signal: ac.signal,
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null, revealed = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    const line = p.trim();
    if (!line.startsWith("data:")) continue;
    let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (evt.type === "session") sessionId = evt.sessionId;
    if (evt.type === "card_reveal") revealed++;
    if (evt.type === "ask_user") {
      const kind = evt.ask?.kind;
      if (kind === "invocation") {
        await fetch(`${BASE}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answers: ["想知道结果", "打算行动", "怕失败"] }) });
      } else if (evt.cardSelection) {
        await fetch(`${BASE}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: "Fool,Lovers,Star|2000,1500,300" }) });
      } else if (kind === "flip") {
        await fetch(`${BASE}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: "翻牌" }) });
      } else {
        await fetch(`${BASE}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: evt.ask?.options?.[0] ?? "好的" }) });
      }
    }
    if (revealed >= 1) { ac.abort(); break; }
  }
  if (revealed >= 1) break;
}
console.log(`sessionId: ${sessionId}  已翻开牌数: ${revealed}`);

// 等快照落库（定时器 10s）
await new Promise((r) => setTimeout(r, 12000));

console.log("\n=== ② 检查 SQLite 快照 ===\n");
const row = db.prepare(`SELECT state_json, status FROM sessions WHERE id = ?`).get(sessionId);
if (!row) { console.log("❌ 找不到会话记录"); process.exit(2); }
console.log(`status: ${row.status}`);
console.log(`state_json 长度: ${row.state_json.length} 字符`);
if (!row.state_json) { console.log("❌ 没有快照"); process.exit(2); }

const snap = JSON.parse(row.state_json);
console.log(`快照内容校验:`);
console.log(`  question: ${snap.question}`);
console.log(`  drawnCards: ${snap.drawnCards.length} 张`);
console.log(`  cardReadings: ${snap.cardReadings.length} 条`);
console.log(`  flippedCardIdx: ${JSON.stringify(snap.flippedCardIdx)}`);
console.log(`  messages: ${snap.messages.length} 条`);
console.log(`  persona: ${snap.personaId}`);

const ok = snap.question === "测试快照功能"
  && snap.drawnCards.length > 0
  && snap.messages.length > 0
  && Array.isArray(snap.flippedCardIdx);

console.log(`\n${ok ? "✅ 快照内容完整" : "❌ 快照内容缺失"}`);

console.log("\n=== ③ 模拟进程重启：清内存 + 从快照恢复 ===\n");
const { getSession, restoreSession, snapshotSession } = await import("../src/lib/agent/session.ts");
// 恢复（restoreSession 会写入内存 Map）
const restored = restoreSession(snap);
if (!restored) { console.log("❌ 恢复失败"); process.exit(2); }
console.log(`恢复成功: ${restored.id}`);
console.log(`  question: ${restored.question}`);
console.log(`  drawnCards: ${restored.drawnCards.length} 张`);
console.log(`  flippedCardIdx: ${JSON.stringify(restored.flippedCardIdx)}`);
console.log(`  restoredFromSnapshot: ${restored.restoredFromSnapshot}`);
console.log(`  pendingAsk: ${restored.pendingAsk ? "有" : "无（预期：Promise 不可序列化）"}`);

const match = restored.question === snap.question
  && restored.drawnCards.length === snap.drawnCards.length
  && JSON.stringify(restored.flippedCardIdx) === JSON.stringify(snap.flippedCardIdx);

console.log(`\n${match ? "✅ 恢复字段一致" : "❌ 恢复字段不一致"}`);
console.log(`\n${ok && match ? "✅ 全部通过" : "❌ 有问题"}`);
process.exit(ok && match ? 0 : 2);
