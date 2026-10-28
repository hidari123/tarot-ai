#!/usr/bin/env node
/** 方向⑤验证：persona_suggest 触发路径（blade + 焦虑自答） */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 300000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    question: "我很焦虑，怕自己撑不下去了，工作婚姻都一团糟",
    persona: "blade",
  }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let sessionId = null;
let t0 = Date.now();
let suggestFired = false;

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

    if (evt.type === "session") sessionId = evt.sessionId;

    if (evt.type === "persona_suggest") {
      suggestFired = true;
      console.log(`\n[${at}s] 🎭 PERSONA_SUGGEST 触发: ${evt.personaSuggest?.emoji} ${evt.personaSuggest?.name}`);
      console.log(`   理由: ${evt.personaSuggest?.reason}\n`);
    }

    if (evt.type === "ask_user") {
      const kind = evt.ask?.kind ?? "(none)";
      let body;
      if (kind === "invocation") {
        body = { sessionId, answers: ["想知道接下来该怎么办", "很迷茫不知道做什么", "特别焦虑担心撑不住"] };
      } else if (evt.cardSelection) {
        body = { sessionId, answer: "Fool,Lovers,Star|2000,1500,300" };
      } else {
        // 关键：自由回答里带强焦虑词，保证 emotionTags 收录"紧张不安/迷茫"
        body = { sessionId, answer: evt.ask?.options?.[0] ?? "我很焦虑，也很迷茫" };
      }
      await fetch(`${BASE}/api/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    if (evt.type === "error") {
      console.log(`[${at}s] ✗ error: ${evt.error}`);
      process.exit(1);
    }
    if (evt.type === "done") {
      console.log(`[${at}s] ✓ done`);
      console.log(`\n🎭 persona_suggest: ${suggestFired ? "✓ 触发" : "✗ 未触发"}`);
      process.exit(suggestFired ? 0 : 2);
    }
  }
}
