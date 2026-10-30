#!/usr/bin/env node
/**
 * 验证：SSE 断点续传（P1-③D）+ 事件日志（P2-⑦）
 *
 * 场景：
 *   1. 起一场占卜，收到若干事件后**主动中断**（模拟网络抖动）
 *   2. 记下最后收到的 seq
 *   3. 用 Last-Event-ID + resume:true 请求 → 后端应补发缺失事件
 *   4. 验证：补发的事件 seq 连续、无缺口、类型正确
 *   5. 验证：event_log 表里有结构性事件（可观测性）
 */
import Database from "better-sqlite3";

const BASE = process.argv[2] || "http://localhost:3000";

/** 解析 SSE 帧 → [{seq, data}] */
function parseSSE(text) {
  const out = [];
  for (const frame of text.split("\n\n")) {
    let seq = 0, data = "";
    for (const raw of frame.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("id:")) seq = Number(line.slice(3).trim()) || 0;
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data) {
      try { out.push({ seq, evt: JSON.parse(data) }); } catch { /* ignore */ }
    }
  }
  return out;
}

console.log("\n=== ① 起一场占卜，中途主动断开 ===\n");
const ac = new AbortController();
const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "测试断点续传" }),
  signal: ac.signal,
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null;
const received = [];

while (received.length < 12) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    let seq = 0, data = "";
    for (const raw of p.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("id:")) seq = Number(line.slice(3).trim()) || 0;
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (!data) continue;
    try {
      const evt = JSON.parse(data);
      received.push({ seq, evt });
      if (evt.type === "session") sessionId = evt.sessionId;
    } catch { /* ignore */ }
  }
}

console.log(`收到事件 ${received.length} 个，sessionId: ${sessionId}`);
console.log(`seq 范围: ${received[0]?.seq} ~ ${received[received.length - 1]?.seq}`);
console.log(`事件类型: ${[...new Set(received.map(r => r.evt.type))].join(", ")}`);

// 记录中断点
const cutSeq = received[received.length - 1].seq;
console.log(`\n⚡ 在 seq=${cutSeq} 处模拟断线（abort）`);
ac.abort();

// 等后端把后续事件也生成出来（agent 仍在推进）。
// ⚠️ 用轮询 event_log 代替固定等待：事件数增长即认为 agent 在产出，
//    最长等 60s（比固定 sleep 快且不会白等）。
{
  const db0 = new Database("data/tarot.db");
  const startCount = (() => {
    try {
      return db0.prepare(`SELECT COUNT(*) n FROM event_log WHERE session_id = ?`).get(sessionId).n;
    } catch { return 0; }
  })();
  const t0 = Date.now();
  let last = startCount;
  let stableRounds = 0;
  while (Date.now() - t0 < 60000) {
    await new Promise((r) => setTimeout(r, 3000));
    let cur = 0;
    try {
      cur = db0.prepare(`SELECT COUNT(*) n FROM event_log WHERE session_id = ?`).get(sessionId).n;
    } catch { cur = last; }
    if (cur > last) { last = cur; stableRounds = 0; }
    else {
      stableRounds++;
      // 连续 2 轮（6s）没有新事件 → agent 已停（可能卡在 HITL 等待）
      if (stableRounds >= 2 && last > startCount) break;
    }
  }
  console.log(`agent 后台推进：事件数 ${startCount} → ${last}`);
}

console.log(`\n=== ② 用 Last-Event-ID=${cutSeq} 请求补发 ===\n`);
const resumeRes = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Last-Event-ID": String(cutSeq),
  },
  body: JSON.stringify({ sessionId, resume: true }),
});
console.log(`HTTP ${resumeRes.status}`);
const resumeText = await resumeRes.text();
const resumed = parseSSE(resumeText);

console.log(`补发事件 ${resumed.length} 个`);
console.log(`seq 范围: ${resumed[0]?.seq} ~ ${resumed[resumed.length - 1]?.seq}`);
console.log(`类型: ${[...new Set(resumed.map(r => r.evt.type))].join(", ")}`);

// ---- 校验 ----
console.log(`\n=== ③ 校验 ===\n`);
let ok = true;

// ① 补发的第一个事件必须是 cutSeq+1（无缝衔接）
const firstSeq = resumed[0]?.seq;
const seamless = firstSeq === cutSeq + 1;
console.log(`① 无缝衔接: 期望 ${cutSeq + 1}，实际 ${firstSeq} ${seamless ? "✅" : "❌"}`);
if (!seamless) ok = false;

// ② seq 连续无缺口
let contiguous = true;
for (let i = 1; i < resumed.length; i++) {
  if (resumed[i].seq !== resumed[i - 1].seq + 1) { contiguous = false; break; }
}
console.log(`② seq 连续无缺口: ${contiguous ? "✅" : "❌"}`);
if (!contiguous) ok = false;

// ③ 补发的事件不与已收到的重复
const receivedSeqs = new Set(received.map(r => r.seq));
const noDup = resumed.every(r => !receivedSeqs.has(r.seq));
console.log(`③ 无重复事件: ${noDup ? "✅" : "❌"}`);
if (!noDup) ok = false;

// ④ 补发里有实质内容（phase/tool/card 等）
const meaningful = resumed.filter(r => r.evt.type !== "delta").length;
console.log(`④ 补发含结构性事件: ${meaningful} 个 ${meaningful > 0 ? "✅" : "❌"}`);
if (meaningful === 0) ok = false;

// ⑤ event_log 落库（P2-⑦）
const db = new Database("data/tarot.db");
const row = db.prepare(
  `SELECT COUNT(*) n, MIN(seq) minSeq, MAX(seq) maxSeq FROM event_log WHERE session_id = ?`
).get(sessionId);
console.log(`\n⑤ event_log 落库: ${row.n} 条 (seq ${row.minSeq}~${row.maxSeq}) ${row.n > 0 ? "✅" : "❌"}`);
if (row.n === 0) ok = false;

// ⑥ 事件类型分布
const types = db.prepare(
  `SELECT type, COUNT(*) n FROM event_log WHERE session_id = ? GROUP BY type ORDER BY n DESC`
).all(sessionId);
console.log(`   类型分布: ${types.map(t => `${t.type}×${t.n}`).join(", ")}`);

console.log(`\n${ok ? "✅ 全部通过" : "❌ 有问题"}`);
process.exit(ok ? 0 : 2);
