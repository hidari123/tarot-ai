#!/usr/bin/env node
/**
 * 验证 P0-1：断点续传的 sessionId 闭包过期 bug
 *
 * ⚠️ 这个 bug 的隐蔽性在于：
 *    `startDivination` 的 useCallback 依赖数组里**确实有 sessionId**，
 *    eslint react-hooks/exhaustive-deps 也不会报错 ——
 *    但 catch 块是在**同一次调用栈**内执行的，
 *    此时闭包捕获的 sessionId 是"调用开始时"的值（空串），
 *    而 sessionId 是在 SSE 流里异步设置的（case "session"）。
 *    → 断流时 `if (sessionId && lastSeqRef.current > 0)` 恒为 false
 *    → 恢复分支**一次都进不去**。
 *
 * 本脚本用最小复现验证这个语义（不依赖 React）：
 *   模拟「回调创建时 sessionId='' → 异步设置 → catch 时读闭包值」。
 */

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== P0-1 断点续传闭包过期 ===\n");

/* ---- 复现 ①：闭包捕获旧值 ---- */
{
  // 模拟 React state
  let stateSessionId = "";
  // 模拟 useCallback：创建时捕获 sessionId
  const makeCallback = () => {
    const captured = stateSessionId; // ← useCallback 捕获的值
    return async () => {
      // SSE 流里异步设置 sessionId
      stateSessionId = "sess_real_from_sse";
      // 然后 catch 块读到的是 captured（旧的）
      const capturedNow = captured;
      return { sessionIdInCatch: capturedNow, currentState: stateSessionId };
    };
  };
  const cb = makeCallback();       // 创建时 stateSessionId = ""
  const r = await cb();            // 执行
  check(
    "catch 块读到的是创建时的旧 sessionId（空串）",
    r.sessionIdInCatch === "",
    `catch 里=${JSON.stringify(r.sessionIdInCatch)} · 实际=${r.currentState}`
  );
  check(
    "→ 断点续传分支条件 sessionId && ... 为 false（永远进不去）",
    !(r.sessionIdInCatch && r.currentState),
    "证实：断流后无法自动恢复"
  );
}

/* ---- 复现 ②：ref 方案能修复 ---- */
{
  let stateSessionId = "";
  const sessionIdRef = { current: "" };   // ref 不参与闭包
  const makeCallback = () => {
    const captured = stateSessionId;
    return async () => {
      stateSessionId = "sess_real_from_sse";
      sessionIdRef.current = stateSessionId;  // 同步写 ref
      // catch 块用 ref 读 —— 拿到最新值
      return { fromRef: sessionIdRef.current, fromClosure: captured };
    };
  };
  const cb = makeCallback();
  const r = await cb();
  check(
    "ref 方案能拿到最新 sessionId",
    r.fromRef === "sess_real_from_sse",
    `ref=${r.fromRef}`
  );
  check(
    "→ 断点续传分支条件为 true（可以恢复）",
    !!(r.fromRef && r.fromRef.length > 0),
    "证实：改用 ref 后恢复分支可达"
  );
}

/* ---- 检查当前代码是否真的用了 state 而非 ref ---- */
{
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, "..", "src", "app", "page.tsx"), "utf8");

  const hasRef = /sessionIdRef/.test(src);
  check(
    hasRef ? "代码里已有 sessionIdRef（已修复）" : "代码里没有 sessionIdRef（bug 存在）",
    hasRef,
    hasRef ? "catch 块已改为读 ref" : "catch 块用的是 state 闭包 → 断流后无法恢复"
  );

  // ⚠️ 关键：catch 块必须用 ref，不能用 state 闭包
  const catchBlock = src.match(/catch \(e\) \{[\s\S]*?resumeStream\(\)/);
  const body = catchBlock ? catchBlock[0] : "";
  const usesRef = /sessionIdRef\.current/.test(body);
  const usesState = /\bsessionId\s*&&/.test(body);
  check(
    "catch 块读的是 ref 而不是 state 闭包",
    usesRef && !usesState,
    usesRef ? "已修复" : usesState ? "仍在读 state 闭包 → 恢复分支永远进不去" : "未找到判定"
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
