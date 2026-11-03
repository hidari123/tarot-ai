#!/usr/bin/env node
/**
 * 端到端验证：走完一场真实占卜，确认新加的守卫**没有误伤**
 *
 * ⚠️ 为什么必须测（加守卫最大的风险）：
 *   把守卫从 2 个工具扩到 8 个之后，最可能的失败是：
 *     · 守卫条件写错 → 合法调用被拦 → 流程卡死
 *     · 前置判据与时序不匹配 → 收束永远被拦（synthesis 那个坑）
 *   这个脚本实际跑一场占卜（含自动回答 HITL），
 *   验证承约 → 呼召 → 选牌 → 逐张 → 综合 → 收束 全流程走通。
 *
 * ⚠️ 必须自动回答 HITL：
 *   承约/呼召/选牌都是"问用户 → 等回答"（await Promise），
 *   没人回答的话流程会**正常地**停在第一步 —— 那不是 bug。
 *   所以脚本要扮演用户：收到 ask_user 就 POST /api/answer。
 *
 * 用法：node scripts/verify-e2e-ritual.mjs [baseUrl]
 */

const BASE = process.argv[2] || "http://localhost:3000";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== 端到端占卜流程验证（守卫回归）===\n");
console.log(`目标: ${BASE}\n`);

/** 回答一个 HITL 提问 */
async function answer(sessionId, question, options, kind) {
  // ⚠️ 选项型（选牌）→ 选第一个；自由型 → 给一段合理的回答
  let payload;
  if (options && options.length > 0) {
    payload = options[0];
  } else if (kind === "invocation") {
    payload = "1. 我想要一个明确的方向\n2. 担心代价太大\n3. 希望家人支持";
  } else if (kind === "crossroads") {
    payload = "选择更稳的那条路";
  } else {
    payload = "是的，就这样继续";
  }
  const res = await fetch(`${BASE}/api/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, answer: payload }),
  });
  return res.status;
}

/** 读取一条 SSE 流（支持中途回答 HITL） */
async function readStream(body, sessionIdRef, { timeoutMs = 300000, onEvent }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let evt;
      try { evt = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      events.push(evt);
      if (onEvent) onEvent(evt);
      // ⚠️ 自动回答 HITL
      if (evt.type === "ask_user" && sessionIdRef.current) {
        const st = await answer(
          sessionIdRef.current,
          evt.ask?.question ?? "",
          evt.ask?.options,
          evt.ask?.kind
        );
        console.log(`  ↩ 回答 HITL(${evt.ask?.kind ?? "free"}): ${st}`);
      }
      if (evt.type === "done" || evt.type === "error") return { events, stopped: true };
    }
  }
  return { events, stopped: false };
}

const res = await fetch(`${BASE}/api/interpret`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "我最近在工作上感到迷茫，不知道该不该接受一个新的机会", persona: "mystic" }),
});
if (!res.ok || !res.body) {
  console.error(`❌ 无法开始占卜（status=${res.status}）`);
  process.exit(2);
}

const sessionIdRef = { current: "" };
const toolNames = [];
const subagentActions = [];
const phases = [];
const intercepts = [];
const asks = [];

const { events } = await readStream(res.body, sessionIdRef, {
  timeoutMs: 420000,
  onEvent: (evt) => {
    if (evt.type === "session") {
      sessionIdRef.current = evt.sessionId;
    }
    if (evt.type === "tool") {
      toolNames.push(evt.tool?.name);
      if (String(evt.tool?.resultSummary ?? "").includes("拦截")) intercepts.push(evt.tool?.name);
    }
    if (evt.type === "subagent") subagentActions.push(`${evt.subagent?.agent}:${evt.subagent?.action}`);
    if (evt.type === "phase" && evt.label) phases.push(evt.label);
    if (evt.type === "ask_user") asks.push(evt.ask?.kind ?? "free");
  },
});

console.log(`\n会话 ${sessionIdRef.current}`);
console.log("工具序列：");
for (const t of toolNames) console.log(`  · ${t}`);
console.log(`HITL 提问 ${asks.length} 次：${asks.join(", ")}`);
if (intercepts.length) {
  console.log("守卫拦截：");
  for (const t of intercepts) console.log(`  ⚠ ${t}`);
}
console.log("");

/* ---- ① 关键工具都被调用过 ---- */
{
  const required = ["establish_contract", "invoke_three_questions", "offer_card_selection", "close_reading"];
  const missing = required.filter((t) => !toolNames.includes(t));
  check(
    "关键仪式工具都被调用（承约/呼召/选牌/收束）",
    missing.length === 0,
    missing.length ? `缺: ${missing.join(", ")}` : `共 ${toolNames.length} 次工具调用`
  );
}

/* ---- ② 收束走完（synthesis 时序坑的直接检验）---- */
{
  const hasClosing = toolNames.includes("close_reading");
  check(
    "收束阶段走完了（close_reading 未被守卫误拦）",
    hasClosing,
    hasClosing ? "收束正常" : "⚠️ 没看到 close_reading —— 检查 synthesis 判据"
  );
}

/* ---- ③ 守卫没有误拦合法调用 ---- */
{
  check(
    "守卫未误拦合法调用",
    intercepts.length === 0,
    intercepts.length === 0 ? "零拦截" : `拦截了 ${intercepts.length} 次：${intercepts.join(", ")}`
  );
}

/* ---- ④ 事件序列完整 ---- */
{
  const types = new Set(events.map((e) => e.type));
  const expected = ["session", "phase", "tool", "subagent", "ask_user"];
  const missing = expected.filter((t) => !types.has(t));
  check(
    "事件类型齐全",
    missing.length === 0,
    missing.length ? `缺: ${missing.join(", ")}` : `共 ${events.length} 个事件`
  );
}

/* ---- ⑤ 会话落库 + 有解读正文 ---- */
{
  const sid = sessionIdRef.current;
  if (!sid) {
    check("会话可查询（落库正常）", false, "没拿到 sessionId");
  } else {
    const r = await fetch(`${BASE}/api/session/${sid}`);
    const j = await r.json();
    const reading = String(j.reading ?? "");
    check(
      "会话落库且有解读正文",
      r.ok && reading.length > 50,
      r.ok ? `status=${j.status} reading=${reading.length} 字` : `status=${r.status}`
    );
  }
}

/* ---- ⑥ 流正常结束（收到 done）---- */
{
  const hasDone = events.some((e) => e.type === "done");
  const hasError = events.some((e) => e.type === "error");
  check(
    "流以 done 正常结束",
    hasDone && !hasError,
    hasDone ? "done" : hasError ? "收到 error" : "流提前结束"
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
