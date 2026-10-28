#!/usr/bin/env node
/**
 * 验证逐张翻牌闸门：
 *  1. card_flip_ready 事件**不含牌面**（防剧透）
 *  2. 用户点牌前，收不到 card_reveal
 *  3. 用户点牌后才收到 card_reveal（含牌面）
 *  4. 三张牌按顺序逐张翻，后端不跳步
 */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 300000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "工作提不起劲，想看接下来三个月" }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let sessionId = null;
const t0 = Date.now();
const events = [];
let revealedNames = [];
let flipReadyPayloads = [];
let pendingFlip = null;

const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

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
    events.push(evt.type);

    if (evt.type === "session") sessionId = evt.sessionId;

    /* ---- 闸门信号：必须不含牌面 ---- */
    if (evt.type === "card_flip_ready") {
      flipReadyPayloads.push(evt.cardFlipReady);
      const leak = Object.keys(evt.cardFlipReady ?? {}).filter((k) =>
        ["image", "nameZh", "id", "narrative", "meaning"].includes(k)
      );
      log(`🕯 card_flip_ready #${evt.cardFlipReady?.cardIndex} (${evt.cardFlipReady?.pos}) 泄漏字段: ${leak.length ? leak.join(",") : "无 ✅"}`);
      pendingFlip = evt.cardFlipReady?.cardIndex;
    }

    if (evt.type === "card_reveal") {
      const r = evt.cardReveal;
      revealedNames.push(r.nameZh);
      log(`🂠 card_reveal #${r.cardIndex} ${r.pos}·${r.nameZh} ← 牌面此刻才下发`);
    }

    if (evt.type === "ask_user") {
      const kind = evt.ask?.kind;
      let body;
      if (kind === "invocation") {
        body = { sessionId, answers: ["想看三个月", "打算先调整作息", "怕一直这样"] };
      } else if (evt.cardSelection) {
        body = { sessionId, answer: "Fool,Lovers,Star|2000,1500,300" };
      } else if (kind === "flip") {
        /* ★ 关键：闸门等待 —— 用户"点牌" */
        log(`   👆 用户点开第 ${pendingFlip + 1} 张牌 → POST /api/answer {翻牌}`);
        body = { sessionId, answer: "翻牌" };
      } else {
        body = { sessionId, answer: evt.ask?.options?.[0] ?? "还在等一个理由出发" };
      }
      const r = await fetch(`${BASE}/api/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (kind === "flip" && !r.ok) {
        log(`   ⚠️ 翻牌应答失败: ${r.status} ${await r.text()}`);
      }
    }

    if (evt.type === "error") { log(`✗ error: ${evt.error}`); break; }
    if (evt.type === "done") {
      log(`✓ done`);
      console.log("\n=== 闸门验证 ===");
      console.log(`card_flip_ready 次数: ${flipReadyPayloads.length}（应 = 牌数 3）`);
      console.log(`card_reveal 次数: ${revealedNames.length}（应 = 牌数 3）`);
      console.log(`翻开的牌顺序: ${revealedNames.join(" → ")}`);
      const leaks = flipReadyPayloads.filter((f) =>
        ["image", "nameZh", "id", "narrative", "meaning"].some((k) => k in (f ?? {}))
      );
      console.log(`\n防剧透: ${leaks.length === 0 ? "✅ flip_ready 无牌面泄漏" : "❌ 泄漏了 " + JSON.stringify(leaks)}`);
      const order = flipReadyPayloads.map((f) => f.cardIndex);
      console.log(`顺序: ${order.join(" → ")} ${order.join(",") === "0,1,2" ? "✅ 严格逐张" : "❌ 乱序"}`);
      process.exit(leaks.length === 0 && order.join(",") === "0,1,2" ? 0 : 2);
    }
  }
}
