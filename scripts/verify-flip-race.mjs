#!/usr/bin/env node
/**
 * 验证：翻牌闸门竞态已修（对话流牌阵点击时机）
 *
 * 关键场景：前端收到 card_flip_ready 就点（对话流牌阵面板的时机）。
 * 修复前：后端 pendingAsk 尚未就绪 → 409。
 * 修复后：先 waitUserAnswer（同步设 pendingAsk）再发 flip_ready → 必然成功。
 */
const BASE = process.argv[2] || "http://localhost:3000";
const ac = new AbortController();
setTimeout(() => ac.abort(), 300000);

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "工作提不起劲，想看接下来三个月" }),
  signal: ac.signal,
});
console.log(`HTTP ${res.status}`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", sessionId = null;
const t0 = Date.now();
let flipNo = 0;
const results = [];
const revealTexts = [];

const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);

async function answer(payload) {
  const r = await fetch(`${BASE}/api/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, ...payload }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    log(`   ⚠️ 应答失败 ${r.status}: ${e.error}`);
  }
  return r.ok;
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

    /* ★ 最严苛时机：收到 flip_ready 立刻点（零延迟抢跑） */
    if (evt.type === "card_flip_ready") {
      flipNo++;
      const ok = await answer({ answer: "翻牌" });
      results.push({ n: flipNo, ok });
      log(`🕯 闸门 #${evt.cardFlipReady?.cardIndex} → 立即点击: ${ok ? "✅" : "❌ 409"}`);
    }

    if (evt.type === "ask_user") {
      const kind = evt.ask?.kind;
      if (kind === "invocation") await answer({ answers: ["三个月", "调整作息", "怕一直这样"] });
      else if (evt.cardSelection) await answer({ answer: "Fool,Lovers,Star|2000,1500,300" });
      else await answer({ answer: evt.ask?.options?.[0] ?? "还在等" });
    }

    /* 收集解读正文，检查是否重复 */
    if (evt.type === "delta") revealTexts.push(evt.delta);
    if (evt.type === "card_reading") {
      log(`📖 card_reading #${evt.cardReading?.cardIndex}（正文 ${evt.cardReading?.text ? "带 text ⚠️" : "不带 text ✅"}）`);
    }
    if (evt.type === "error") { log(`✗ ${evt.error}`); break; }
    if (evt.type === "done") {
      const full = revealTexts.join("");
      console.log("\n=== 验证结果 ===");
      console.log(`翻牌应答: ${results.map((r) => (r.ok ? "✅" : "❌")).join(" ")}（全部零延迟抢跑）`);
      // 重复检测：整段解读出现两次
      const paras = full.split(/\n\n/).filter((s) => s.length > 60);
      let dup = 0;
      for (let i = 0; i < paras.length; i++) {
        for (let j = i + 1; j < paras.length; j++) {
          if (paras[i] === paras[j]) { dup++; console.log(`  ❌ 重复段落 #${i} === #${j}（长度 ${paras[i]}）`); }
        }
      }
      console.log(`重复段落数: ${dup} ${dup === 0 ? "✅" : "❌"}`);
      const allOk = results.every((r) => r.ok);
      console.log(`\n${allOk && dup === 0 ? "✅ 全部通过" : "❌ 仍有问题"}`);
      process.exit(allOk && dup === 0 ? 0 : 2);
    }
  }
}
