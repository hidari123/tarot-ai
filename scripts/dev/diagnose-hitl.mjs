#!/usr/bin/env node
/**
 * 诊断：HITL 应答是否真正唤醒后端等待
 * 场景：起一场占卜 → 收到 ask_user 立即应答 → 看后端是否继续推进
 */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 120000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "HITL 应答诊断测试" }),
  signal: ac.signal,
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null;
const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(1);

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
      if (evt.type === "session") { sessionId = evt.sessionId; console.log(`[${t()}s] session: ${sessionId}`); }
      if (evt.type === "ask_user") {
        const kind = evt.ask?.kind;
        console.log(`[${t()}s] ask_user [${kind}] 收到 → 立即应答`);
        const body = kind === "invocation"
          ? { sessionId, answers: ["a", "b", "c"] }
          : { sessionId, answer: kind === "flip" ? "翻牌" : (evt.ask?.options?.[0] ?? "是这样") };
        const r = await fetch(`${BASE}/api/answer`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const txt = await r.text();
        console.log(`[${t()}s]   应答 HTTP ${r.status} ${txt.slice(0, 60)}`);
        if (r.status !== 200) {
          console.log(`   ⚠️ 应答失败 —— 闸门未就绪（抢跑）`);
          // 重试一次（模拟前端的 409 静默重试）
          await new Promise((r2) => setTimeout(r2, 300));
          const r3 = await fetch(`${BASE}/api/answer`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          console.log(`[${t()}s]   重试 HTTP ${r3.status}`);
        }
      }
      if (evt.type === "tool") console.log(`[${t()}s] tool ${evt.tool.name} → 后端继续推进 ✅`);
      if (evt.type === "error") { console.log(`[${t()}s] ✗ ${evt.error}`); process.exit(1); }
      if (evt.type === "done") { console.log(`[${t()}s] ✓ done`); process.exit(0); }
    } catch { /* ignore */ }
  }
}
