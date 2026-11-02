#!/usr/bin/env node
/**
 * 快速全链路验证：一场真实 LLM 占卜（glm-5.3）
 * 验证：承约 → 呼召 → 选牌 → 翻牌 → 解读 → 收束 → done 全流程
 */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 300000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "下周面试表现会怎么样" }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null, done = false, llmUsed = false;
const types = [];
const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(1);

async function answer(payload) {
  const r = await fetch(`${BASE}/api/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...payload }),
  });
  return r.ok;
}

while (true) {
  const { done: d, value } = await reader.read();
  if (d) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    let data = "";
    for (const raw of p.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (!data) continue;
    try {
      const evt = JSON.parse(data);
      if (!types.includes(evt.type)) types.push(evt.type);
      if (evt.type === "session") sessionId = evt.sessionId;
      if (evt.type === "tool") { llmUsed = true; console.log(`[${t()}s] 🔧 ${evt.tool.name}: ${String(evt.tool.resultSummary ?? "").slice(0, 50)}`); }
      if (evt.type === "ask_user") {
        const kind = evt.ask?.kind;
        console.log(`[${t()}s] ❓ [${kind}] ${String(evt.ask?.question ?? "").slice(0, 44)}`);
        if (kind === "invocation") await answer({ answers: ["想知道能不能通过", "准备技术要点", "怕紧张发挥失常"] });
        else if (evt.cardSelection) await answer({ answer: "Fool,Lovers,Star|2000,1500,3000" });
        else if (kind === "flip") await answer({ answer: "翻牌" });
        else await answer({ answer: evt.ask?.options?.[0] ?? "是这样" });
      }
      if (evt.type === "card_reveal") console.log(`[${t()}s] 🂠 ${evt.cardReveal.nameZh}（${evt.cardReveal.pos}）`);
      if (evt.type === "card_reading") console.log(`[${t()}s] 📖 第${evt.cardReading.cardIndex + 1}张讲完`);
      if (evt.type === "reasoning") llmUsed = true;
      if (evt.type === "error") { console.log(`[${t()}s] ✗ ${evt.error}`); process.exit(1); }
      if (evt.type === "done") { done = true; console.log(`\n[${t()}s] ✓ done`); break; }
    } catch { /* ignore */ }
  }
  if (done) break;
}
console.log(`\n事件类型: ${types.join(", ")}`);
console.log(`LLM 参与: ${llmUsed ? "✅（reasoning/tool 事件）" : "❌（疑似本地降级）"}`);
const ok = done && llmUsed;
console.log(ok ? "✅ 真实 LLM 全链路通过" : "⚠️ 未确认 LLM 参与（可能走了降级）");
process.exit(0);
