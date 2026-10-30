#!/usr/bin/env node
/** 快速诊断：起一场占卜，打出所有事件看哪里失败 */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 90000);
const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "ping 诊断" }),
  signal: ac.signal,
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null, answered = 0;
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
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
      if (evt.type === "session") sessionId = evt.sessionId;
      if (evt.type === "error") { console.log(`✗ ERROR: ${evt.error}`); process.exit(1); }
      if (evt.type === "ask_user") {
        const kind = evt.ask?.kind;
        console.log(`❓ [${kind}] ${String(evt.ask?.question ?? "").slice(0, 40)}`);
        answered++;
        if (answered > 3) { console.log("… 收到 3 个问题后停止（诊断目的达到）"); process.exit(0); }
        const body = kind === "invocation"
          ? { sessionId, answers: ["想知道结果", "打算行动", "怕失败"] }
          : evt.cardSelection
            ? { sessionId, answer: "Fool,Lovers,Star|2000,1500,3000" }
            : { sessionId, answer: evt.ask?.options?.[0] ?? "好的" };
        await fetch(`${BASE}/api/answer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      if (evt.type === "done") { console.log("✓ done"); process.exit(0); }
    } catch { /* ignore */ }
  }
}
console.log("流结束（无 done）");
