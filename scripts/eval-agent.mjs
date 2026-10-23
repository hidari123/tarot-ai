/**
 * Agent 评估脚本 —— 固定题集自动 E2E + 断言
 *
 * 维度（每题 0/0.5/1 分）：
 *   clarify   是否发起澄清(ask_user)或选牌交互(offer_card_selection)
 *   rag       是否调用 rag_search 且命中数 > 0
 *   cite      解读文本是否包含「典籍有云」引用
 *   complete  是否产出 done 事件且有实质解读(>200 字)
 *   review    是否走完审校(review 事件)
 *
 * 运行：node scripts/eval-agent.mjs http://localhost:3000
 */

const BASE = process.argv[2] || "http://localhost:3000";

const CASES = [
  { id: "love-vague", question: "我的感情运势怎么样", expectClarify: true },
  { id: "work-specific", question: "下周的面试能通过吗，我很紧张", expectClarify: false },
  { id: "money", question: "最近想投资一个朋友推荐的项目，靠谱吗", expectClarify: true },
];

const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS) || 420000; // 多 Agent 管线较慢，留足时间

async function runCase(tc) {
  const events = [];
  const deltas = [];
  let sessionId = null;
  let answered = 0;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: tc.question }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done = false;

    while (!done) {
      const { done: d, value } = await reader.read();
      if (d) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          events.push(evt);
          if (evt.type === "delta") deltas.push(evt.delta);
          if (evt.type === "session") sessionId = evt.sessionId;
          if (evt.type === "done") done = true;

          // 自动应答 HITL
          if (evt.type === "ask_user" && sessionId && answered < 2) {
            answered++;
            const ans =
              evt.cardSelection
                ? "Fool,Lovers,Star|2000,1500,3000"
                : evt.ask.options?.[0] ?? "我想更进一步了解";
            await fetch(`${BASE}/api/answer`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId, answer: ans }),
            });
          }
        } catch { /* 忽略解析失败 */ }
      }
    }
  } catch (e) {
    return { ...tc, error: e.message, events, deltas: deltas.join("") };
  } finally {
    clearTimeout(timer);
  }

  const reading = deltas.join("");
  const tools = events.filter((e) => e.type === "tool").map((e) => e.tool.name);
  const asked = events.some((e) => e.type === "ask_user");
  const ragHit = events.some((e) => e.type === "rag_hits" && (e.ragHits?.length ?? 0) > 0);
  const cited = reading.includes("典籍有云") || /\[\d+\]/.test(reading);
  const complete = events.some((e) => e.type === "done") && reading.length > 200;
  const reviewed = events.some((e) => e.type === "review");

  const scores = {
    clarify: tc.expectClarify ? (asked ? 1 : 0) : (asked ? 0.5 : 1), // 不该问却问了给一半
    rag: ragHit ? 1 : 0,
    cite: cited ? 1 : 0,
    complete: complete ? 1 : 0,
    review: reviewed ? 1 : 0,
  };

  return { ...tc, error: null, tools, readingLen: reading.length, scores, events, reading };
}

/* ---- 主流程 ---- */
console.log(`\n🔮 Agent 评估 · ${BASE}\n`);
const results = [];
for (const tc of CASES) {
  process.stdout.write(`  [${tc.id}] ${tc.question} … `);
  const r = await runCase(tc);
  results.push(r);
  if (r.error) {
    console.log(`✗ ERROR: ${r.error}`);
  } else {
    const total = Object.values(r.scores).reduce((a, b) => a + b, 0);
    const max = Object.values(r.scores).length;
    console.log(`${(total / max * 100).toFixed(0)}%  clarify=${r.scores.clarify} rag=${r.scores.rag} cite=${r.scores.cite} complete=${r.scores.complete} review=${r.scores.review}  (${r.tools.length} tools, ${r.readingLen} chars)`);
  }
}

// 汇总
const all = results.filter((r) => !r.error);
if (all.length > 0) {
  const avg = (k) => all.reduce((s, r) => s + r.scores[k], 0) / all.length;
  console.log(`\n📊 汇总（n=${all.length}）`);
  console.log(`  clarify:  ${(avg("clarify") * 100).toFixed(0)}%`);
  console.log(`  rag:      ${(avg("rag") * 100).toFixed(0)}%`);
  console.log(`  cite:     ${(avg("cite") * 100).toFixed(0)}%`);
  console.log(`  complete: ${(avg("complete") * 100).toFixed(0)}%`);
  console.log(`  review:   ${(avg("review") * 100).toFixed(0)}%`);
  const overall = all.reduce((s, r) => s + Object.values(r.scores).reduce((a, b) => a + b, 0), 0) /
    (all.length * Object.keys(all[0].scores).length);
  console.log(`  ─────────────────`);
  console.log(`  总体通过率: ${(overall * 100).toFixed(0)}%`);
}

const failed = results.filter((r) => r.error);
if (failed.length) {
  console.log(`\n⚠ ${failed.length} 个用例执行失败`);
  process.exit(1);
}
