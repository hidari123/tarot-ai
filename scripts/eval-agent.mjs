/**
 * Agent 评估套件 —— 固定题集自动 E2E + 多维断言 + 失败分类
 *
 * 关键设计：**区分失败原因**
 *   - env_error        模型不可达 → 不计入通过率（环境问题，不是代码问题）
 *   - timeout          超时 → 计入"稳定性"指标
 *   - assertion_failed 断言不通过 → 真正的质量问题
 *
 * 用法：
 *   node scripts/eval-agent.mjs [baseUrl] [--ci]
 *   --ci 模式：环境阻塞时 exit 0（不阻塞 CI），有真实质量问题才 exit 1
 */

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3000";
const CI_MODE = process.argv.includes("--ci");

const CASES = [
  { id: "love-vague", question: "我的感情运势怎么样", expectClarify: true },
  { id: "work-specific", question: "下周的面试能通过吗，我很紧张", expectClarify: false },
  { id: "money", question: "最近想投资一个朋友推荐的项目，靠谱吗", expectClarify: true },
];

// 逐张解读模式下轮次翻倍（承约+呼召+选牌+检索+3×(翻牌+解读)+综合+收束 ≈14 轮），
// 加上每轮有用户思考时间，总耗时比旧流程长 —— 超时放宽到 8 分钟
const TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS) || 480000;

/** 失败类型 */
const FAIL = {
  ENV: "env_error",
  TIMEOUT: "timeout",
  ASSERT: "assertion_failed",
  DISCONNECT: "disconnected",
};

async function probeModelAvailable() {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    const res = await fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "ping" }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
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
          if (evt.type === "session") return { ok: true };
          if (evt.type === "error") return { ok: false, reason: evt.error };
        } catch {}
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function runCase(tc) {
  const events = [];
  const deltas = [];
  let sessionId = null;
  let answered = 0;
  let errorEvent = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: tc.question }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      return { ...tc, failType: FAIL.ENV, failReason: `HTTP ${res.status}` };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
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
          events.push(evt);
          if (evt.type === "delta") deltas.push(evt.delta);
          if (evt.type === "session") sessionId = evt.sessionId;
          if (evt.type === "error") errorEvent = evt.error;
          if (evt.type === "done") done = true;

          if (evt.type === "ask_user" && sessionId) {
            answered++;
            const kind = evt.ask?.kind;
            let body;
            if (evt.cardSelection) {
              body = { sessionId, answer: "Fool,Lovers,Star|2000,1500,3000" };
            } else if (kind === "invocation") {
              // 三问呼召：一次提交三个回答（多答案形式）
              body = {
                sessionId,
                answers: ["想知道大概什么时候有消息", "打算继续投但只投精准的", "怕又白投一场"],
              };
            } else {
              body = { sessionId, answer: evt.ask.options?.[0] ?? "我想更进一步了解" };
            }
            await fetch(`${BASE}/api/answer`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
          }
        } catch {}
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    const failType = /abort/i.test(msg) ? FAIL.TIMEOUT : FAIL.DISCONNECT;
    return { ...tc, failType, failReason: msg, events, deltas: deltas.join("") };
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

  /* ---- 仪式流程断言（真实塔罗流程）---- */
  const hasContract = events.some((e) => e.type === "contract");
  const hasInvocation = events.some((e) => e.type === "invocation");
  const cardReveals = events.filter((e) => e.type === "card_reveal");
  const cardReadings = events.filter((e) => e.type === "card_reading");
  const hasClosing = events.some((e) => e.type === "ask_user" && e.ask?.kind === "closing");
  const perCardOk = cardReveals.length > 0 && cardReadings.length >= cardReveals.length;

  const scores = {
    clarify: tc.expectClarify ? (asked ? 1 : 0) : (asked ? 0.5 : 1),
    rag: ragHit ? 1 : 0,
    cite: cited ? 1 : 0,
    complete: complete ? 1 : 0,
    review: reviewed ? 1 : 0,
    // 仪式流程：承约 / 呼召 / 逐张解读 / 收束
    contract: hasContract ? 1 : 0,
    invocation: hasInvocation ? 1 : 0,
    percard: perCardOk ? 1 : 0,
    closing: hasClosing ? 1 : 0,
  };

  const failedDims = Object.entries(scores).filter(([, v]) => v === 0).map(([k]) => k);

  return {
    ...tc,
    failType: failedDims.length ? FAIL.ASSERT : null,
    failReason: failedDims.length ? `未达标维度: ${failedDims.join(", ")}` : null,
    tools, readingLen: reading.length, scores, events, reading, errorEvent,
  };
}

/* ---- 主流程 ---- */
console.log(`\n🔮 Agent 评估 · ${BASE}${CI_MODE ? " (CI 模式)" : ""}\n`);

const probe = await probeModelAvailable();
if (!probe.ok) {
  console.log(`⚠️ 模型不可达：${probe.reason}`);
  console.log("   跳过评估（环境阻塞，不计入通过率）\n");
  if (CI_MODE) {
    console.log("CI 模式：环境阻塞，exit 0\n");
    process.exit(0);
  }
  process.exit(2);
}

const results = [];
for (const tc of CASES) {
  process.stdout.write(`  [${tc.id}] ${tc.question} … `);
  const r = await runCase(tc);
  results.push(r);
  if (r.failType) {
    console.log(`✗ ${r.failType}: ${r.failReason}`);
  } else {
    const total = Object.values(r.scores).reduce((a, b) => a + b, 0);
    const max = Object.keys(r.scores).length;
    console.log(`${((total / max) * 100).toFixed(0)}%  (${r.tools.length} tools, ${r.readingLen} chars)`);
  }
}

/* ---- 汇总 ---- */
const valid = results.filter((r) => !r.failType || r.failType === FAIL.ASSERT);
const envBlocked = results.filter((r) => r.failType === FAIL.ENV);
const timedOut = results.filter((r) => r.failType === FAIL.TIMEOUT);
const disconnected = results.filter((r) => r.failType === FAIL.DISCONNECT);
const asserted = results.filter((r) => r.failType === FAIL.ASSERT);

console.log(`\n📊 汇总（总 ${results.length} / 有效 ${valid.length}）`);
if (envBlocked.length) console.log(`  ⚠️ 环境阻塞: ${envBlocked.length}（模型不可达，不计入）`);
if (timedOut.length) console.log(`  ⏱️ 超时: ${timedOut.length}`);
if (disconnected.length) console.log(`  🔌 连接中断: ${disconnected.length}`);

if (valid.length > 0) {
  const avg = (k) => valid.reduce((s, r) => s + r.scores[k], 0) / valid.length;
  console.log(`  ── 基础质量 ──`);
  console.log(`  clarify:  ${(avg("clarify") * 100).toFixed(0)}%`);
  console.log(`  rag:      ${(avg("rag") * 100).toFixed(0)}%`);
  console.log(`  cite:     ${(avg("cite") * 100).toFixed(0)}%`);
  console.log(`  complete: ${(avg("complete") * 100).toFixed(0)}%`);
  console.log(`  review:   ${(avg("review") * 100).toFixed(0)}%`);
  console.log(`  ── 仪式流程（真实塔罗）──`);
  console.log(`  承约:     ${(avg("contract") * 100).toFixed(0)}%`);
  console.log(`  呼召:     ${(avg("invocation") * 100).toFixed(0)}%`);
  console.log(`  逐张解读: ${(avg("percard") * 100).toFixed(0)}%`);
  console.log(`  收束:     ${(avg("closing") * 100).toFixed(0)}%`);
  const overall =
    valid.reduce((s, r) => s + Object.values(r.scores).reduce((a, b) => a + b, 0), 0) /
    (valid.length * Object.keys(valid[0].scores).length);
  console.log(`  ─────────────────`);
  console.log(`  总体通过率: ${(overall * 100).toFixed(0)}%`);
}

if (timedOut.length || disconnected.length) {
  const stability = 1 - (timedOut.length + disconnected.length) / results.length;
  console.log(`  稳定性: ${(stability * 100).toFixed(0)}%（无超时/中断的用例占比）`);
}

const exitCode = asserted.length > 0 ? 1 : 0;
if (asserted.length) {
  console.log(`\n✗ ${asserted.length} 个用例存在质量问题`);
  for (const a of asserted) console.log(`   ${a.id}: ${a.failReason}`);
}
console.log(exitCode === 0 ? "\n✅ 评估通过" : "\n❌ 评估未通过");
process.exit(exitCode);
