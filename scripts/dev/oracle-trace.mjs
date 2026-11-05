#!/usr/bin/env node
/**
 * 诊断：抓神谕的原始 SSE 事件流，定位「回复发两遍」的根因
 *
 * ⚠️ 关键：要区分两种重复：
 *   ① 后端发了两次内容（协议层重复）
 *   ② 后端只发一次，前端渲染了两遍（渲染层重复）
 *   → 本脚本打印**原始事件序列**，能立刻分辨。
 */
const BASE = process.argv[2] || "http://localhost:3000";

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "一句话说说什么是宝剑三？", kind: "oracle" }),
});

console.log("HTTP", res.status);
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const events = [];
let deltaText = "";
let fullText = "";

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const line = raw.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let p;
    try {
      p = JSON.parse(payload);
    } catch {
      continue;
    }
    const keys = Object.keys(p).join(",");
    events.push({ type: p.type, keys });
    if (p.type === "delta") {
      deltaText += p.delta ?? "";
    }
    // ⚠️ 看有没有"整段正文"型事件（非 delta）
    const s = JSON.stringify(p);
    if (p.type !== "delta" && /reading|text|content/i.test(s) && s.length > 200) {
      fullText += s;
    }
    if (p.type === "done") {
      console.log("收到 done");
    }
  }
}

console.log("\n=== 事件类型统计 ===");
const counts = {};
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

console.log(`\ndelta 累加长度: ${deltaText.length}`);
console.log(`其它事件里的大文本字段: ${fullText.length}`);
console.log(`\n=== 事件序列（前 30 个） ===`);
events.slice(0, 30).forEach((e, i) => console.log(`  ${i}: ${e.type} [${e.keys}]`));

// ⚠️ 判定：delta 累加的正文里是否**本身**就重复了？
console.log(`\n=== 正文前 300 字 ===`);
console.log(deltaText.slice(0, 300));
const half = Math.floor(deltaText.length / 2);
console.log(`\n=== 中点是否等于开头（自我重复检测）===`);
console.log(`前半 === 后半 ? ${deltaText.slice(0, half) === deltaText.slice(half)}`);
