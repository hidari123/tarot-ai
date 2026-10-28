#!/usr/bin/env node
/** 方向⑤验证：plan 事件是否触发 + persona_suggest 是否触发 + 事件序列完整性 */
const BASE = process.argv[2] || "http://localhost:3000";
const question = process.argv[3] || "我最近压力很大，工作总是提不起劲，想看看接下来三个月的运势";
const ac = new AbortController();
setTimeout(() => ac.abort(), 300000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question, persona: process.argv[4] || undefined }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let sessionId = null;
let t0 = Date.now();
const seen = [];
const answers = {
  invocation: ["想知道接下来三个月的关键", "打算先调整作息再谈工作", "怕一直这样提不起劲"],
};

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    const line = p.trim();
    if (!line.startsWith("data:")) continue;
    let evt;
    try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
    const at = ((Date.now() - t0) / 1000).toFixed(1);
    if (!seen.includes(evt.type)) seen.push(evt.type);

    if (evt.type === "plan") {
      console.log(`\n[${at}s] 📋 PLAN 事件触发，步骤:`);
      (evt.plan ?? []).forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
    }
    if (evt.type === "persona_suggest") {
      console.log(`\n[${at}s] 🎭 PERSONA_SUGGEST: ${evt.personaSuggest?.emoji} ${evt.personaSuggest?.name}`);
      console.log(`   理由: ${evt.personaSuggest?.reason}`);
    }
    if (evt.type === "session") sessionId = evt.sessionId;
    if (evt.type === "ask_user") {
      const kind = evt.ask?.kind ?? "(none)";
      let ans;
      if (kind === "invocation") {
        ans = answers.invocation;
        await fetch(`${BASE}/api/answer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answers: ans }),
        });
      } else if (kind === "card_confirm") {
        ans = evt.ask?.options?.[0] ?? "是这样";
        await fetch(`${BASE}/api/answer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: ans }),
        });
      } else if (evt.cardSelection) {
        ans = "Fool,Lovers,Star|2000,1500,300";
        await fetch(`${BASE}/api/answer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: ans }),
        });
      } else {
        ans = evt.ask?.options?.[0] ?? "对，就是这个";
        await fetch(`${BASE}/api/answer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: ans }),
        });
      }
    }
    if (evt.type === "error") {
      console.log(`[${at}s] ✗ error: ${evt.error}`);
      process.exit(1);
    }
    if (evt.type === "done") {
      console.log(`\n[${at}s] ✓ done`);
      console.log(`\n=== 收到的事件类型 ===\n${seen.join(" · ")}`);
      const hasPlan = seen.includes("plan");
      const hasSuggest = seen.includes("persona_suggest");
      console.log(`\n📋 plan 事件: ${hasPlan ? "✓ 触发" : "✗ 未触发"}`);
      console.log(`🎭 persona_suggest: ${hasSuggest ? "✓ 触发" : "（本场情绪不匹配建议条件，正常）"}`);
      process.exit(0);
    }
  }
}
