import { readFileSync, writeFileSync } from "node:fs";

// ⚠️ 最终方案：用 useEffect 同步 ref（而不是 useEffectEvent）
// ⚠️ 原因：useEffectEvent 的返回值**不能离开该 hook**
//         → consumeStream 要交给 page.tsx 用 → 违规 ❌
// ⚠️ 官方替代：在 effect 里写 ref（规则允许），事件处理器里读（也允许）
// ⚠️ 时序安全：effect 在挂载后立即跑；本 hook 只在用户交互后被调用 → 早已同步 ✅

const P = "src/features/divination/useStreamRunner.ts";
let s = readFileSync(P, "utf-8");

/* ---------- ① dispatch：useEffectEvent → useCallback + ref ---------- */
s = s.replace(
  `  /**
   * ⚠️⚠️ 事件分发用 useEffectEvent 包装
   * · 永远读到最新的 state/extras，但**引用永不变**
   * · consumeStream 因此可以在依赖数组里放它 → 不会每次渲染重建 ✅
   */
  const dispatch = useEffectEvent((p: NonNullable<ReturnType<typeof parseAgentEvent>>) => {`,
  `  /**
   * ⚠️⚠️ 事件分发：state/extras 用 ref 镜像，dispatch 本身引用稳定
   * · 永远读到最新的 state/extras → 但 dispatch 不会每次渲染重建 ✅
   * · consumeStream 因此可以安全地依赖它 → 下游 useCallback 不会失效 ✅
   *
   * ⚠️⚠️ 为什么 ref 在 **useEffect** 里写，而不是渲染期直接写：
   *   · eslint 的 \`react-hooks/refs\` 规则**禁止**渲染期写 ref.current（React 19 新规则）❌
   *   · 在 effect 里写是官方允许的写法 ✅
   *   · 时序安全：effect 在挂载后立即执行；本 hook 只在用户交互后被调用
   *     → 交互发生时 ref 早已同步 ✅
   */
  const paramsRef = useRef({ state, extras });
  useEffect(() => {
    paramsRef.current = { state, extras };
  });

  const dispatch = useCallback((p: NonNullable<ReturnType<typeof parseAgentEvent>>) => {
    const { state: st, extras: ex } = paramsRef.current;
    const {
      setSessionId, setPhase, setPhaseLabel, setRateLimited, setReasoning,
      setTools, setRagHits, setSpread, setAsk, setFanCards, setFanCount,
      setEntries, setSubagentEvents, setPlanSteps, setPersonaSuggest,
      setRounds, setReview, setError, setCanFollowup,
    } = st;
    const {
      sessionIdRef, deltaTargetRef, deltaBufferRef, scheduleDeltaFlush,
      nextEntryId, pushEntry,
    } = ex;
    return dispatchImpl(p, {
      setSessionId, setPhase, setPhaseLabel, setRateLimited, setReasoning,
      setTools, setRagHits, setSpread, setAsk, setFanCards, setFanCount,
      setEntries, setSubagentEvents, setPlanSteps, setPersonaSuggest,
      setRounds, setReview, setError, setCanFollowup,
      sessionIdRef, deltaTargetRef, deltaBufferRef, scheduleDeltaFlush,
      nextEntryId, pushEntry,
    });
  }, []);`
);

/* ---------- ② consumeStream：useEffectEvent → useCallback ---------- */
s = s.replace(
  `  /**
   * ⚠️⚠️ consumeStream 也用 useEffectEvent 包（不是 useCallback）
   * · 规则：useEffectEvent 的返回值**只能直接调用**，不能被 useCallback 捕获
   *   → eslint \`react-hooks/rules-of-hooks\` 明确禁止 ❌
   * · consumeStream 本来就该"永远读到最新 state" → useEffectEvent 正是这个语义 ✅
   */
  const consumeStream = useEffectEvent(async (res: Response) => {`,
  `  /**
   * ⚠️ consumeStream 用 useCallback（引用稳定，可交给 page.tsx）
   * · dispatch 引用稳定 → 依赖数组里放它没问题 ✅
   */
  const consumeStream = useCallback(async (res: Response) => {`
);

s = s.replace(/\r?\n  \}\);\r?\n\r?\n  \/\*\* 取消在途的 SSE 请求/, "\n  });\n\n  /** 取消在途的 SSE 请求");

/* ---------- ③ import 调整 ---------- */
s = s.replace(
  'import { useCallback, useEffectEvent, useRef } from "react";',
  'import { useCallback, useEffect, useRef } from "react";'
);

writeFileSync(P, s, "utf-8");
console.log("✓ 改为 useCallback + effect 同步 ref");
