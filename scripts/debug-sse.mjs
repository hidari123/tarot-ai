/** 实时调试 SSE 流：打印每类事件 + 时延，定位卡点 */
const BASE = process.argv[2] || "http://localhost:3000";
const question = process.argv[3] || "最近想投资一个朋友推荐的项目，靠谱吗";

const t0 = Date.now();
const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question }),
});
console.log(`HTTP ${res.status} (${Date.now() - t0}ms)`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let lastEvtTime = Date.now();
let sessionId = null;
let done = false;

while (!done) {
  const { done: d, value } = await reader.read();
  if (d) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    const line = p.trim();
    if (!line.startsWith("data:")) continue;
    try {
      const evt = JSON.parse(line.slice(5).trim());
      const now = Date.now();
      const gap = now - lastEvtTime;
      lastEvtTime = now;
      const since = now - t0;
      if (evt.type === "session") sessionId = evt.sessionId;
      if (evt.type === "delta") {
        // delta 太频繁，只在首 token 与每 50 字打点
        if (!globalThis._firstDelta) {
          console.log(`  [${since}ms] 首个 delta (+${gap}ms)`);
          globalThis._firstDelta = true;
        } else if ((globalThis._dcount = (globalThis._dcount || 0) + 1) % 50 === 0) {
          console.log(`  [${since}ms] … ${globalThis._dcount} chunks`);
        }
      } else if (evt.type === "ask_user") {
        console.log(`  [${since}ms] ask_user (+${gap}ms): ${evt.ask.question?.slice(0, 40)}`);
        // 自动应答
        if (sessionId) {
          const ans = evt.cardSelection ? "Fool,Lovers,Star|2000,1500,3000" : (evt.ask.options?.[0] ?? "我想更进一步了解");
          await fetch(`${BASE}/api/answer`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, answer: ans }),
          });
          console.log(`  [${Date.now() - t0}ms] 已应答: ${ans.slice(0, 30)}`);
        }
      } else if (evt.type === "done") {
        done = true;
        console.log(`  [${since}ms] done ✓ 总耗时 ${since / 1000}s`);
      } else if (evt.type === "error") {
        console.log(`  [${since}ms] ✗ error: ${evt.error}`);
        done = true;
      } else if (evt.type === "tool") {
        console.log(`  [${since}ms] tool ${evt.tool.name} (+${gap}ms) → ${String(evt.tool.resultSummary).slice(0, 60)}`);
      } else if (evt.type === "round") {
        console.log(`  [${since}ms] round ${evt.round.round} 耗时${evt.round.elapsedMs}ms tools=${evt.round.toolNames.join(",")}`);
      } else {
        const brief = evt.type === "phase" ? evt.phase : evt.type === "review" ? `pass=${evt.review?.pass}` : evt.type === "rag_hits" ? `${evt.ragHits?.length} hits` : "";
        console.log(`  [${since}ms] ${evt.type} (+${gap}ms) ${brief}`);
      }
    } catch {}
  }
}
if (!done) console.log("⚠️ 流结束但无 done 事件");
process.exit(0);
