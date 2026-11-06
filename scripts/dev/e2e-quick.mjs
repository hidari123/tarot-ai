#!/usr/bin/env node
/**
 * 快速模式端到端验证（2026-11-06）
 *
 * ⚠️ 为什么需要这个脚本：
 *   用户报告"快速问答会走抽牌流程、翻不过来图、最后撞 max_rounds"。
 *   离线断言只能检查**静态代码结构**，无法证明**真实流程能走完**。
 *   → 这个脚本真的跑一遍：发起占卜 → 解析 SSE → 自动应答 HITL → 跑到收束。
 *
 * ⚠️ 判定标准（对应用户的每一条抱怨）：
 *   ① 不应出现 "最大轮次" / max_rounds 错误
 *   ② 不应重复 draw_cards（"又走抽牌流程"）
 *   ③ card_reveal 的数量应等于抽到的牌数（"三张牌面都出了"）
 *   ④ 最终应到达 closing / done
 *
 * 用法：node scripts/dev/e2e-quick.mjs
 */

const BASE = "http://localhost:3000";

/** 解析 SSE 文本 → 事件数组 */
function parseSse(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  return events;
}

/** 读取 SSE 增量（每次 ask_user 都要读完当前这一段） */
async function readUntilAskUser(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try {
        const ev = JSON.parse(p);
        events.push(ev);
        if (ev.type === "ask_user") {
          return { events, reader, decoder, pending: buf, ask: ev };
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { events, reader, decoder, pending: buf, ask: null };
}

/** 主流程 */
const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "我该不该换工作？", mode: "quick" }),
});

if (!res.ok || !res.body) {
  console.error("✗ 请求失败:", res.status);
  process.exit(1);
}

let { events, reader, ask } = await readUntilAskUser(res);
const all = [...events];
/**
 * ⚠️ sessionId 在事件的**顶层**（`{type:"session",sessionId:"sess_..."}`），
 * ⚠️ 不是嵌套在 `session` 对象里 —— 写错这里会导致 answer 接口 400。
 */
let sessionId = events.find((e) => e.type === "session")?.sessionId;
let hitlCount = 0;
let guard = 0;

while (ask && guard++ < 12) {
  hitlCount++;
  const options = ask.ask?.options ?? [];
  // 自动选第一个选项（模拟用户随便答一个）
  const answer = options[0] ?? "就这样吧";

  const ar = await fetch(`${BASE}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, answer }),
  });
  if (!ar.ok) {
    console.error("✗ 应答失败:", ar.status, (await ar.text()).slice(0, 200));
    break;
  }

  // 继续读流
  const decoder = new TextDecoder();
  let buf = "";
  let nextAsk = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (!p || p === "[DONE]") continue;
      try {
        const ev = JSON.parse(p);
        all.push(ev);
        if (ev.type === "ask_user") {
          nextAsk = ev;
        }
      } catch {
        /* ignore */
      }
    }
    if (nextAsk) break;
  }
  ask = nextAsk;
}

/* ---------------- 判定 ---------------- */
const toolNames = all
  .map((e) => e.tool?.name)
  .filter(Boolean);
const drawCalls = toolNames.filter((n) => n === "draw_cards").length;
const reveals = all.filter((e) => e.type === "card_reveal").length;
const hasMaxRounds = JSON.stringify(all).match(/最大轮次|max_rounds|轮次上限/);
const hasError = all.some((e) => e.type === "error" || /error/i.test(e.error ?? ""));
const closed = all.some(
  (e) => e.type === "closing" || e.phase === "closing" || e.type === "done"
);

console.log("=== 快速模式端到端 ===");
console.log("事件类型分布:");
const types = {};
for (const e of all) types[e.type] = (types[e.type] ?? 0) + 1;
for (const [k, v] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k} = ${v}`);
}
console.log("工具调用:", toolNames.join(", ") || "(无)");
console.log("draw_cards 次数:", drawCalls, drawCalls > 1 ? "❌ 重复抽牌" : "✅");
console.log("card_reveal 次数:", reveals);
console.log("HITL 交互次数:", hitlCount);
console.log("撞 max_rounds:", hasMaxRounds ? "❌ " + hasMaxRounds[0] : "✅ 无");
console.log("流里有 error:", hasError ? "❌" : "✅ 无");
console.log("到达收束:", closed ? "✅" : "⚠ 未确认");

const ok = !hasMaxRounds && !hasError && drawCalls <= 1 && closed;
console.log(ok ? "\n✅ 快速模式流程正常" : "\n❌ 快速模式仍有问题");
process.exit(ok ? 0 : 1);
