#!/usr/bin/env node
/**
 * 端到端：神谕模式（2026-11-04 D 方向）
 *
 * ⚠️ 验证要点：
 *   ① 神谕能正常回答（不卡在 max_rounds）
 *   ② **不调用任何抽牌类工具**（draw_cards / offer_card_selection / reveal_card）
 *   ③ 检索有发生（神谕要查典籍，不能凭记忆背牌义）
 *   ④ 追问能继续（上下文保留）
 *
 * 用法：npx tsx scripts/dev/e2e-oracle.mjs [baseUrl]
 */

const BASE = process.argv[2] || "http://localhost:3000";

/** 读 SSE 事件 */
async function streamSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
      try {
        onEvent(JSON.parse(payload));
      } catch {
        /* 忽略坏帧 */
      }
    }
  }
}

console.log("=== 端到端：神谕（Oracle）===\n");

const tools = [];
const ragCalls = [];
let text = "";
let sessionId = null;
let error = null;
let done = false;
const t0 = Date.now();

/**
 * ⚠️ 神谕会用 ask_user 提问（对话的本质）→ SSE 会**挂起**等用户回答。
 *   → 脚本必须自动回答，否则永远等不到 done。
 *   答案固定为一句话（够真实，且不会引入歧义）。
 */
const AUTO_ANSWER = "我想先看宝剑三这一张到底在说什么，星星先放一放。";

console.log("起问神谕: ", BASE);
const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    question: "宝剑三和星星这两张牌放在一起是什么意思？",
    kind: "oracle",
  }),
});

console.log("HTTP", res.status);
let askedCount = 0;

/**
 * ⚠️ 神谕会用 ask_user 提问 → SSE 挂起等回答 → 必须回发才能继续。
 *   回答走 /api/answer（与占卜同一个端点）。
 */
let answerSent = false;
await streamSse(res, (e) => {
  if (e.type === "session") sessionId = e.sessionId;
  if (e.type === "tool") tools.push(e.tool?.name ?? "?");
  if (e.type === "rag_hits") ragCalls.push((e.ragHits ?? []).length);
  if (e.type === "delta") text += e.delta ?? "";
  if (e.type === "error") error = e.error;
  if (e.type === "done") done = true;
  if (e.type === "ask_user" && !answerSent) {
    askedCount++;
    answerSent = true;
    // 异步回发答案（不阻塞 SSE 读取）
    setTimeout(() => {
      fetch(`${BASE}/api/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer: AUTO_ANSWER }),
      }).catch(() => {});
    }, 200);
  }
});

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== 神谕结果 ===`);
console.log(`耗时: ${elapsed}s`);
console.log(`回答长度: ${text.length} 字`);
console.log(`完结: ${done ? "是" : "否"}`);
console.log(`工具序列: ${tools.join(" → ") || "（无）"}`);
console.log(`检索事件: ${ragCalls.length} 次（命中 ${ragCalls.join(",")} 条）`);
console.log(`提问次数: ${askedCount}`);
console.log(`错误: ${error ?? "无"}`);

console.log(`\n回答开头: ${text.slice(0, 160).replace(/\n/g, " ")}`);

// ---- 断言 ----
const DRAW_TOOLS = ["draw_cards", "offer_card_selection", "reveal_card", "interpret_card", "write_reading", "establish_contract", "invoke_three_questions", "fate_crossroads"];
const usedDraw = tools.filter((t) => DRAW_TOOLS.includes(t));

console.log("\n=== 断言 ===");
const checks = [
  ["神谕正常完结（没卡死）", done],
  ["没有调用抽牌/岔路类工具", usedDraw.length === 0, usedDraw.join(",")],
  ["调用了检索（查了典籍）", tools.includes("rag_search")],
  ["产生了回答内容", text.length > 30, `${text.length} 字`],
  ["回答长度克制（≤1200 字，不是长篇报告）", text.length <= 1200, `${text.length} 字`],
  ["没有报错", !error, error ?? ""],
  ["拿到了 sessionId（可追问）", !!sessionId],
];

let pass = 0, fail = 0;
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
}

// ---- 追问测试 ----
if (sessionId) {
  console.log("\n=== 追问 ===");
  let fText = "";
  let fDone = false;
  const fr = await fetch(`${BASE}/api/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, followup: "那如果逆位呢？" }),
  });
  console.log("HTTP", fr.status);
  await streamSse(fr, (e) => {
    if (e.type === "delta") fText += e.delta ?? "";
    if (e.type === "done") fDone = true;
    if (e.type === "error") error = e.error;
  });
  console.log(`追问回答: ${fText.length} 字 · 完结: ${fDone ? "是" : "否"}`);
  console.log(`追问开头: ${fText.slice(0, 120).replace(/\n/g, " ")}`);
  const ok = fDone && fText.length > 20;
  console.log(`  ${ok ? "✓" : "✗"} 追问能继续（上下文保留）`);
  ok ? pass++ : fail++;
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
