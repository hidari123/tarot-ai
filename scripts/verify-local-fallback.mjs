#!/usr/bin/env node
/**
 * 验证：本地降级引擎全流程（无可用 LLM provider 时）
 *
 * MiniMax 402（余额不足）→ 主备切换也失败 → 本地剧本引擎接管。
 * 期望：完整跑完 澄清→抽牌→念牌→解读→收束→done，不白屏不报错。
 */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 150000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "本地引擎全流程验证" }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null, done = false, errors = [];
const types = [];
const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(1);

async function answer(payload) {
  await fetch(`${BASE}/api/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...payload }),
  });
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
      if (evt.type === "error") errors.push(evt.error);
      if (evt.type === "ask_user") {
        const kind = evt.ask?.kind;
        if (kind === "invocation") await answer({ answers: ["想知道结果", "打算行动", "怕失败"] });
        else if (evt.cardSelection) await answer({ answer: "Fool,Lovers,Star|2000,1500,3000" });
        else if (kind === "flip") await answer({ answer: "翻牌" });
        else await answer({ answer: evt.ask?.options?.[0] ?? "好的" });
      }
      if (evt.type === "done") { done = true; console.log(`\n[${t()}s] ✓ done`); process.exit(0); }
    } catch { /* ignore */ }
  }
}
console.log(`\n[${t()}s] 流结束（done=${done}）`);
console.log(`事件类型: ${types.join(", ")}`);
if (errors.length) console.log(`错误: ${errors.join(" | ")}`);
console.log(done ? "✅ 本地引擎全流程通过" : "❌ 未收到 done");
process.exit(done ? 0 : 2);
