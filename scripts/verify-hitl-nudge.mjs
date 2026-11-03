#!/usr/bin/env node
/**
 * 验证 HITL 分级提醒（P1-⑧）
 *
 * ⚠️ 为什么要专门测（而不是靠肉眼看）：
 *    分级提醒的核心逻辑是「**提醒不结束等待**」——
 *    如果实现写错（提醒时把 promise resolve 了），
 *    用户会在 30 秒时被"自动跳过"自己的提问，仪式直接崩掉。
 *    这类 bug 在界面上很难察觉（看起来"流程正常结束"），
 *    只能靠单测锁住不变量。
 *
 * 验证四条：
 *   ① 提醒触发但**不结束等待**（核心不变量）
 *   ② 两级提醒的时间点正确（30s / 2min）
 *   ③ 用户中途应答 → 提醒**不再触发**（timer 被清理）
 *   ④ 超时兜底仍工作（5 分钟后 resolve 哨兵值）
 *
 * ⚠️ 用真实计时但把阈值调小 —— 否则测试要跑 5 分钟。
 *    所以这里直接调 waitUserAnswer，但用**环境变量**改阈值。
 *    ⚠️ 陷阱：环境变量在 import 时读取 → 必须在 import **之前**设置。
 */

process.env.HITL_NUDGE_1_MS = "200";
process.env.HITL_NUDGE_2_MS = "500";
process.env.HITL_TIMEOUT_MS = "1200";

const { waitUserAnswer, isHitlGone, HITL_ABANDONED } = await import("../src/lib/agent/hitl.ts");

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

/** 造一个最小 session 对象（waitUserAnswer 只用到 pendingAsk / abortSignal） */
const makeSession = () => ({ id: "test-session", pendingAsk: undefined, abortSignal: undefined });

console.log("=== HITL 分级提醒验证 ===\n");
console.log(`阈值: 提醒1=200ms · 提醒2=500ms · 超时=1200ms\n`);

/* ---- ① 提醒触发但不结束等待 ---- */
{
  const session = makeSession();
  const nudges = [];
  const t0 = Date.now();
  let resolved = false;

  // ⚠️ 注意：这里保留**原始 promise**，用 .then 只做"是否已 resolve"的观测，
  //    不要把 .then 的返回值当成结果（then 回调没返回值 → 结果是 undefined）。
  const raw = waitUserAnswer(session, "问题？", undefined, "contract", undefined, (level, kind) => {
    nudges.push({ level, kind, at: Date.now() - t0 });
  });
  raw.then(() => { resolved = true; });

  // 等到两级提醒都该触发，但还没到超时
  await new Promise((r) => setTimeout(r, 700));

  check(
    "两级提醒都触发了",
    nudges.length === 2,
    `收到 ${nudges.length} 条（level=${nudges.map((n) => n.level).join(",")}）`
  );
  check(
    "提醒触发时**仍在等待**（核心不变量）",
    !resolved,
    resolved ? "❌ 已被提前 resolve" : "✅ promise 仍在 pending"
  );
  check(
    "提醒带上了 kind",
    nudges.every((n) => n.kind === "contract"),
    `kind=${nudges.map((n) => n.kind).join(",")}`
  );

  // 用户现在应答
  session.pendingAsk?.resolve("用户的回答");
  const r = await raw;
  check("用户应答后正常返回", r === "用户的回答" && !isHitlGone(r), `返回 "${r}"`);
}

/* ---- ② 提醒的时间点正确 ---- */
{
  const session = makeSession();
  const nudges = [];
  const t0 = Date.now();
  const p = waitUserAnswer(session, "问题？", undefined, "flip", undefined, (level) => {
    nudges.push({ level, at: Date.now() - t0 });
  });
  await new Promise((r) => setTimeout(r, 700));
  session.pendingAsk?.resolve("翻牌");
  await p;

  const n1 = nudges.find((n) => n.level === 1);
  const n2 = nudges.find((n) => n.level === 2);
  check(
    "level 1 在 ~200ms 触发",
    n1 && n1.at >= 150 && n1.at < 400,
    n1 ? `实际 ${n1.at}ms` : "未触发"
  );
  check(
    "level 2 在 ~500ms 触发",
    n2 && n2.at >= 400 && n2.at < 700,
    n2 ? `实际 ${n2.at}ms` : "未触发"
  );
  check(
    "level 2 晚于 level 1",
    n1 && n2 && n2.at > n1.at,
    n1 && n2 ? `${n1.at}ms → ${n2.at}ms` : ""
  );
}

/* ---- ③ 提前应答后不再触发提醒（timer 被清理）---- */
{
  const session = makeSession();
  const nudges = [];
  const p = waitUserAnswer(session, "问题？", undefined, "invocation", undefined, (level) => {
    nudges.push(level);
  });
  // 立刻应答
  session.pendingAsk?.resolve("马上回答");
  await p;
  // 等待越过两个提醒时间点
  await new Promise((r) => setTimeout(r, 700));
  check(
    "提前应答后不再触发提醒（timer 已清理）",
    nudges.length === 0,
    `仍收到 ${nudges.length} 条提醒`
  );
}

/* ---- ④ 超时兜底仍工作 ---- */
{
  const session = makeSession();
  const nudges = [];
  const t0 = Date.now();
  const p = waitUserAnswer(session, "问题？", undefined, "closing", undefined, (level) => {
    nudges.push(level);
  });
  const v = await p;
  const elapsed = Date.now() - t0;
  check(
    "超时后 resolve 哨兵值",
    v === HITL_ABANDONED && isHitlGone(v),
    `返回 "${v}"（${elapsed}ms）`
  );
  check(
    "超时前提醒照常触发",
    nudges.length === 2,
    `${nudges.length} 条`
  );
  check(
    "pendingAsk 已清理（不留悬空 ask）",
    session.pendingAsk === undefined,
    session.pendingAsk ? "仍残留" : "已清空"
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
