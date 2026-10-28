/** 调试仪式流程：打印全部 SSE 事件类型序列 + 自动应答 HITL */
const BASE = process.argv[2] || "http://localhost:3000";
const question = process.argv[3] || "我能找到工作吗，现在海投简历都没回音";
const ac = new AbortController();
setTimeout(() => ac.abort(), 300000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let sessionId = null;
let t0 = Date.now();
const seq = [];

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

    switch (evt.type) {
      case "session":
        sessionId = evt.sessionId;
        console.log(`[${at}s] session`);
        break;
      case "contract":
        seq.push("contract");
        console.log(`[${at}s] ✦ 承约: ${evt.contract?.question}`);
        console.log(`         范围: ${evt.contract?.scope}`);
        break;
      case "invocation":
        seq.push("invocation");
        console.log(`[${at}s] ✦ 呼召三问:`);
        (evt.invocation?.questions ?? []).forEach((q, i) => console.log(`         ${i + 1}. ${q}`));
        break;
      case "card_reveal": {
        seq.push("reveal");
        const r = evt.cardReveal;
        console.log(`[${at}s] 🂠 翻牌 ${r.cardIndex + 1}/${r.total} ${r.pos}·${r.nameZh}${r.reversed ? "(逆)" : ""}`);
        console.log(`         画面: ${String(r.narrative).slice(0, 60)}...`);
        console.log(`         牌意: ${String(r.meaning).slice(0, 50)}...`);
        break;
      }
      case "card_reading": {
        seq.push("reading");
        console.log(`[${at}s] 📖 第${evt.cardReading?.cardIndex + 1}张解读: ${String(evt.cardReading?.text).slice(0, 70)}...`);
        break;
      }
      case "ask_user": {
        const kind = evt.ask?.kind ?? "(none)";
        seq.push(`ask:${kind}`);
        console.log(`[${at}s] ❓ [${kind}] ${String(evt.ask?.question).slice(0, 70).replace(/\n/g, " | ")}`);
        if (sessionId) {
          let ans;
          if (kind === "invocation") {
            ans = ["想知道大概什么时候有消息", "打算继续投但只投精准的", "怕又白投一场"];
            await fetch(`${BASE}/api/answer`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, answers: ans }),
            });
            console.log(`         → 三问已答`);
          } else if (kind === "card_confirm") {
            ans = evt.ask?.options?.[0] ?? "是这样";
            await fetch(`${BASE}/api/answer`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, answer: ans }),
            });
            console.log(`         → ${ans}`);
          } else if (evt.cardSelection) {
            ans = "Fool,Lovers,Star|2000,1500,300";
            await fetch(`${BASE}/api/answer`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, answer: ans }),
            });
            console.log(`         → 已选牌`);
          } else {
            ans = evt.ask?.options?.[0] ?? "对，就是这个";
            await fetch(`${BASE}/api/answer`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, answer: ans }),
            });
            console.log(`         → ${ans}`);
          }
        }
        break;
      }
      case "tool":
        console.log(`[${at}s] 🔧 ${evt.tool.name}: ${String(evt.tool.resultSummary).slice(0, 60)}`);
        break;
      case "plan":
        seq.push("plan");
        console.log(`[${at}s] 📋 Plan-Execute 仪轨计划:`);
        (evt.plan ?? []).forEach((s, i) => console.log(`         ${i + 1}. ${s}`));
        break;
      case "persona_suggest":
        seq.push("persona_suggest");
        console.log(`[${at}s] 🎭 人格建议: ${evt.personaSuggest?.emoji} ${evt.personaSuggest?.name}（${String(evt.personaSuggest?.reason).slice(0, 50)}…）`);
        break;
      case "round":
        console.log(`[${at}s] ── round ${evt.round.round} (${evt.round.elapsedMs}ms) ${evt.round.toolNames.join(",")}`);
        break;
      case "done":
        console.log(`[${at}s] ✓ done`);
        console.log(`\n=== 事件序列 ===\n${seq.join(" → ")}`);
        process.exit(0);
      case "error":
        console.log(`[${at}s] ✗ error: ${evt.error}`);
        process.exit(1);
      default:
        break;
    }
  }
}
