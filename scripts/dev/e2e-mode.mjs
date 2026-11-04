#!/usr/bin/env node
/**
 * 端到端：实测两种模式的完整占卜（对比 HITL 交互次数与轮次）
 *
 * ⚠️ 验证重点：**守卫死锁**（快速模式跳过呼召，若守卫仍检查全部前置会卡死）
 * ⚠️ 用法：npx tsx scripts/dev/e2e-mode.mjs [quick|deep] http://localhost:3000
 */
const mode = process.argv[2] || "quick";
const BASE = process.argv[3] || "http://localhost:3000";

console.log(`=== 端到端：${mode} 模式 ===\n`);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "我该不该换工作？", persona: "mystic", mode }),
});
console.log(`起占卜(${mode}): ${res.status}`);

let sessionId = null;
const types = [];
let toolCalls = 0;
const toolNames = [];
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let done = false;
const t0 = Date.now();

while (!done && Date.now() - t0 < 120_000) {
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
    if (evt.type === "tool") { toolCalls++; toolNames.push(evt.tool?.name ?? "?"); }
    if (evt.type === "ask_user") {
      console.log(`  → 等待应答 kind=${evt.ask?.kind}  「${String(evt.ask?.question ?? "").slice(0, 40)}」`);
      const answerRes = await fetch(`${BASE}/api/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer: "我想先看清楚眼前的情况" }),
      });
      if (answerRes.status !== 200) console.log(`  ! 应答失败 ${answerRes.status}`);
    }
    if (evt.type === "done") { done = true; break; }
    if (evt.type === "error") { console.log(`  ! error: ${evt.error}`); done = true; break; }
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const asks = types.filter((t) => t === "ask_user").length;
const rounds = types.filter((t) => t === "round").length;

console.log(`\n=== ${mode} 模式结果 ===`);
console.log(`耗时: ${elapsed}s`);
console.log(`事件总数: ${types.length}`);
console.log(`HITL 交互次数: ${asks}`);
console.log(`LLM 轮次(round): ${rounds}`);
console.log(`工具调用: ${toolCalls}`);
console.log(`工具序列: ${toolNames.join(" → ")}`);
console.log(`完结: ${done ? "是" : "否"}`);

// 校验：呼召是否被跳过
const hasInvocation = toolNames.includes("invoke_three_questions");
console.log(`\n呼召三问: ${hasInvocation ? "执行了" : "跳过了"} ${mode === "quick" ? "(预期跳过)" : "(预期执行)"}`);
console.log(`interpret_card 次数: ${toolNames.filter((n) => n === "interpret_card").length}`);
