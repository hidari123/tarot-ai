#!/usr/bin/env node
/**
 * 防剧透验证（牌面视觉层）
 *
 * 保护目标（已与需求方确认）：**牌面视觉** ——
 *   牌阵面板里未翻开的牌显示牌背 + ？
 *   牌面图片与牌名要等用户亲手翻开（card_reveal）才补上
 *
 * 检查项：
 *   1. cards 事件**不含**牌名/图片（牌阵面板初始化拿不到答案）
 *   2. card_flip_ready 不含牌名/图片
 *   3. 牌名/图片只在 card_reveal 之后才出现
 *
 * ⚠️ 不检查 reasoning / delta / rag_hits —— 那些是模型自己写的解读内容，
 *    解读本来就要说出牌名（"你抽到的是愚者"），拦掉反而破坏内容。
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

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let sessionId = null;
const t0 = Date.now();

const problems = [];
const cardsPayloads = [];
const flipReadyPayloads = [];
const revealed = [];

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

    if (evt.type === "session") sessionId = evt.sessionId;

    /* ---- 牌阵初始化：不得含牌名/图片 ---- */
    if (evt.type === "cards") {
      cardsPayloads.push(evt.cards ?? []);
      const leaky = (evt.cards ?? []).filter((c) => c.nameZh || c.image);
      log(`▣ cards 事件：${(evt.cards ?? []).length} 张，泄漏牌名/图片 ${leaky.length} 张 ${leaky.length === 0 ? "✅" : "❌"}`);
      if (leaky.length) problems.push(`cards 事件泄漏 ${leaky.length} 张牌的牌名/图片`);
    }

    /* ---- 翻牌闸门信号：不得含牌名/图片 ---- */
    if (evt.type === "card_flip_ready") {
      const fr = evt.cardFlipReady ?? {};
      flipReadyPayloads.push(fr);
      const leaky = ["nameZh", "image", "id", "narrative", "meaning"].filter((k) => k in fr);
      log(`🕯 card_flip_ready #${fr.cardIndex} (${fr.pos}) 泄漏字段: ${leaky.length ? leaky.join(",") : "无 ✅"}`);
      if (leaky.length) problems.push(`card_flip_ready 泄漏字段: ${leaky.join(",")}`);
      // 用户点牌
      const r = await fetch(`${BASE}/api/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer: "翻牌" }),
      });
      if (!r.ok) problems.push(`翻牌应答失败: ${r.status}`);
    }

    if (evt.type === "card_reveal") {
      const r = evt.cardReveal;
      revealed.push({ idx: r.cardIndex, name: r.nameZh, hasImage: !!r.image });
      log(`🂠 card_reveal #${r.cardIndex} ${r.nameZh} ← 牌名与图片此刻才下发`);
    }

    if (evt.type === "ask_user") {
      const kind = evt.ask?.kind;
      let body;
      if (kind === "invocation") body = { sessionId, answers: ["想看三个月", "调整作息", "怕一直这样"] };
      else if (evt.cardSelection) body = { sessionId, answer: "Fool,Lovers,Star|2000,1500,300" };
      else body = { sessionId, answer: evt.ask?.options?.[0] ?? "还在等一个理由出发" };
      await fetch(`${BASE}/api/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    if (evt.type === "error") { problems.push(`流程错误: ${evt.error}`); break; }
    if (evt.type === "done") {
      console.log("\n=== 牌面视觉防剧透结论 ===");
      console.log(`cards 事件: ${cardsPayloads.length} 次`);
      console.log(`card_flip_ready: ${flipReadyPayloads.length} 次（应 = 牌数）`);
      console.log(`card_reveal: ${revealed.length} 次 → ${revealed.map((r) => r.name).join(" → ")}`);
      const order = flipReadyPayloads.map((f) => f.cardIndex);
      console.log(`翻转顺序: ${order.join(" → ")} ${order.join(",") === "0,1,2" ? "✅ 严格逐张" : "❌ 乱序"}`);
      const allHaveImage = revealed.every((r) => r.hasImage);
      console.log(`牌面图片在 reveal 时下发: ${allHaveImage ? "✅" : "❌"}`);

      if (problems.length === 0) {
        console.log(`\n✅ 通过：牌阵面板在用户点开前拿不到任何牌面信息`);
      } else {
        console.log(`\n❌ ${problems.length} 处问题：`);
        problems.forEach((p) => console.log(`   - ${p}`));
      }
      process.exit(problems.length === 0 ? 0 : 2);
    }
  }
}
