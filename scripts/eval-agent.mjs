/**
 * Agent 评估套件 —— 固定题集自动 E2E + 多维断言 + 失败分类
 *
 * 关键设计：**区分失败原因**
 *   - env_error        模型不可达 → 不计入通过率（环境问题，不是代码问题）
 *   - timeout          超时 → 计入"稳定性"指标
 *   - assertion_failed 断言不通过 → 真正的质量问题
 *
 * P2-⑥ 题集扩容：3 条 → 34 条（scripts/eval-cases.json，分层抽样）
 *   原因：3 个样本时 98% 的置信区间极宽 —— 一条用例变化就是 33 个点。
 *   现在按主题/问法分层统计，并支持并发跑（--concurrency N）。
 *
 * 用法：
 *   node scripts/eval-agent.mjs [baseUrl] [--ci] [--concurrency N] [--only id1,id2]
 *   --ci 模式：环境阻塞时 exit 0（不阻塞 CI），有真实质量问题才 exit 1
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3000";
const CI_MODE = process.argv.includes("--ci");
/** 并发度（默认 3 —— 再高会撞 LLM 速率限制） */
const CONCURRENCY = Number(process.argv.find((a) => a.startsWith("--concurrency"))?.split("=")[1]) || 3;
/** 只跑指定用例（调试用） */
const ONLY = process.argv.find((a) => a.startsWith("--only"))?.split("=")[1]?.split(",");

/** 题集（分层抽样，见 scripts/eval-cases.json） */
const ALL_CASES = JSON.parse(
  readFileSync(join(__dirname, "eval-cases.json"), "utf-8")
).cases;
const CASES = ONLY ? ALL_CASES.filter((c) => ONLY.includes(c.id)) : ALL_CASES;

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
    hitlCount: answered, // HITL 交互次数（承约/呼召/选牌/确认/继续/收束）
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
/**
 * 并发执行（P2-⑥）
 * ⚠️ 为什么并发：34 条用例串行要 ~40 分钟（每条 ~70s），
 *    没法当"改完代码就跑一下"的日常反馈。
 *    并发 3 → ~13 分钟。再高会撞 LLM 速率限制。
 */
let running = 0;
let doneCount = 0;
const queue = [...CASES];

async function worker() {
  while (queue.length) {
    const tc = queue.shift();
    if (!tc) break;
    const r = await runCase(tc);
    results.push(r);
    doneCount++;
    const pct = ((doneCount / CASES.length) * 100).toFixed(0);
    if (r.failType) {
      console.log(`  [${pct}%] [${tc.id}] ✗ ${r.failType}: ${r.failReason}`);
    } else {
      const total = Object.values(r.scores).reduce((a, b) => a + b, 0);
      const max = Object.keys(r.scores).length;
      console.log(
        `  [${pct}%] [${tc.id}] ${((total / max) * 100).toFixed(0)}%  (${r.tools.length} tools, ${r.readingLen} chars, ${r.hitlCount} HITL)`
      );
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, CASES.length) }, () => worker()));

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

  // ---- 分层统计（P2-⑥）：按 dims 分组，看是哪类问题拖后腿 ----
  const byDim = new Map();
  for (const r of valid) {
    for (const d of r.dims ?? ["untagged"]) {
      if (!byDim.has(d)) byDim.set(d, []);
      byDim.get(d).push(r);
    }
  }
  if (byDim.size > 1) {
    console.log(`  ── 分层（按维度）──`);
    const sorted = [...byDim.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [dim, rs] of sorted) {
      const score =
        rs.reduce((s, r) => s + Object.values(r.scores).reduce((a, b) => a + b, 0), 0) /
        (rs.length * Object.keys(rs[0].scores).length);
      const fails = rs.filter((r) => r.failType).length;
      const flag = fails > 0 ? ` ⚠️ ${fails} 条未达标` : "";
      console.log(`  ${dim.padEnd(12)} ${(score * 100).toFixed(0)}%  (${rs.length} 条)${flag}`);
    }
  }

  // ---- 方差报告（P2-⑥）：单次结果有抖动，多跑几次看稳定性 ----
  const perCase = valid.map((r) => {
    const total = Object.values(r.scores).reduce((a, b) => a + b, 0);
    return total / Object.keys(r.scores).length;
  });
  const mean = perCase.reduce((a, b) => a + b, 0) / perCase.length;
  const variance = perCase.reduce((s, v) => s + (v - mean) ** 2, 0) / perCase.length;
  console.log(`  ─────────────────`);
  console.log(`  单例得分: 均值 ${(mean * 100).toFixed(1)}% · 标准差 ${(Math.sqrt(variance) * 100).toFixed(1)}%`);
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
