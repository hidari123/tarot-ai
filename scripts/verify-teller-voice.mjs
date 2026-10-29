#!/usr/bin/env node
/**
 * 验证：占卜师是否在用户回答后主动回应（问题 2）
 *
 * 判定：delta 事件里是否出现"用户回答之前没有、之后出现"的占卜师话语。
 * 简化做法：统计 flip 闸门之后、card_reveal 之前是否有 delta（回应），
 * 以及 card_confirm 回答之后、解读之前是否有 delta（回应）。
 */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 300000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "我最近压力很大，工作提不起劲" }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null;
const t0 = Date.now();
const t = () => ((Date.now() - t0) / 1000).toFixed(1);

// 事件时间线（记录 delta 段落）
const timeline = [];
let cur = null;

function closeSeg() {
  if (cur && cur.text.trim()) timeline.push(cur);
  cur = null;
}

async function answer(payload) {
  await fetch(`${BASE}/api/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...payload }),
  });
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split("\n\n");
  buf = parts.pop() ?? "";
  for (const p of parts) {
    const line = p.trim();
    if (!line.startsWith("data:")) continue;
    let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }

    if (evt.type === "session") sessionId = evt.sessionId;

    if (evt.type === "delta") {
      if (!cur) cur = { kind: "delta", text: "", at: t() };
      cur.text += evt.delta;
      continue;
    }

    closeSeg();

    if (evt.type === "ask_user") {
      const kind = evt.ask?.kind;
      timeline.push({ kind: `ask:${kind}`, text: String(evt.ask?.question ?? "").slice(0, 40), at: t() });
      if (kind === "invocation") await answer({ answers: ["想看三个月", "调整作息", "怕一直这样"] });
      else if (evt.cardSelection) await answer({ answer: "Fool,Lovers,Star|2000,1500,300" });
      else if (kind === "flip") await answer({ answer: "翻牌" });
      else await answer({ answer: evt.ask?.options?.[0] ?? "还在等" });
    }
    if (evt.type === "card_reveal") timeline.push({ kind: "reveal", text: evt.cardReveal?.nameZh ?? "", at: t() });
    if (evt.type === "card_reading") timeline.push({ kind: "reading", text: `#${evt.cardReading?.cardIndex}`, at: t() });
    if (evt.type === "phase") timeline.push({ kind: `phase:${evt.phase}`, text: evt.label ?? "", at: t() });

    if (evt.type === "error") { console.log(`[${t()}s] ✗ ${evt.error}`); break; }
    if (evt.type === "done") {
      closeSeg();
      console.log("\n=== 时间线（占卜师话语 vs 结构事件）===");
      timeline.forEach((e) => {
        const preview = e.kind === "delta" ? e.text.slice(0, 46).replace(/\n/g, " ") : e.text;
        console.log(`  [${e.at}s] ${e.kind.padEnd(16)} ${preview}`);
      });
      // 判定：每个 reveal 之前是否有一段 delta（占卜师的引子/回应）
      const reveals = timeline.map((e, i) => ({ e, i })).filter((x) => x.e.kind === "reveal");
      let withIntro = 0;
      for (const { i } of reveals) {
        const prev = timeline.slice(0, i).reverse().find((e) => e.kind === "delta");
        if (prev) withIntro++;
      }
      const totalDeltas = timeline.filter((e) => e.kind === "delta").length;
      console.log(`\n占卜师话语段数: ${totalDeltas}`);
      console.log(`翻牌前有引子的次数: ${withIntro}/${reveals.length}`);
      console.log(totalDeltas >= reveals.length ? "✅ 占卜师有主动回应" : "⚠️ 回应仍偏少");
      process.exit(0);
    }
  }
}
