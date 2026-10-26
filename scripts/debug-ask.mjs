/** 抓取 ask_user 事件的完整 JSON（检查 options 字段是否真的到达前端） */
const BASE = process.argv[2] || "http://localhost:3000";
const question = process.argv[3] || "下周的面试能通过吗，我很紧张";
const ac = new AbortController();
setTimeout(() => ac.abort(), 240000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question }),
  signal: ac.signal,
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let sessionId = null;
let n = 0;

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    const line = p.trim();
    if (!line.startsWith("data:")) continue;
    try {
      const evt = JSON.parse(line.slice(5).trim());
      if (evt.type === "session") sessionId = evt.sessionId;
      if (evt.type === "ask_user") {
        n++;
        console.log(`\n=== ask_user #${n} 完整事件 JSON ===`);
        console.log(JSON.stringify(evt, null, 2));
        console.log(`  → options 是数组? ${Array.isArray(evt.ask.options)}  长度=${evt.ask.options?.length}`);
        console.log(`  → crossroads=${evt.crossroads} cardSelection=${evt.cardSelection}`);
        if (sessionId) {
          const ans = evt.cardSelection ? "Fool,Lovers,Star|2000,1500,300" : (evt.ask.options?.[0] ?? "我想更进一步了解");
          await fetch(`${BASE}/api/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, answer: ans }),
          });
          console.log(`  → 已应答: ${String(ans).slice(0, 40)}`);
        }
      }
      if (evt.type === "done") { console.log("\ndone ✓"); process.exit(0); }
    } catch {}
  }
}
