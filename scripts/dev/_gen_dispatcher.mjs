import { readFileSync, writeFileSync } from "node:fs";

// ⚠️ 生成 useEventDispatcher.ts
// ⚠️ ⚠️ 参数类型**复用** useDivinationState 的 DivinationStateApi（不手写，避免漂移）
const SWITCH = readFileSync("scripts/dev/_switch_body.txt", "utf-8");

// ⚠️ 保留完整 switch（含闭合的 "}"）
const inner = SWITCH.trimEnd();
const reindented = inner
  .split(/\r?\n/)
  .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
  .join("\n");

const header = `import { useCallback, useRef } from "react";

import { playSfx } from "@/lib/audio/ambient";
import type { AgentEventPayload } from "@/lib/agent/schema";

import { STAGE_GONG_PHASES } from "./types";
import type { AgentCard, FlowEntry, SpreadCard } from "./types";
import type { DivinationStateApi } from "./useDivinationState";

/**
 * useEventDispatcher —— SSE 协议事件 → 页面状态（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么单独抽出来：
 *   · 事件分发的 switch 有 **420 行**（19 种协议事件）→ 整个页面最大的单块逻辑
 *   · 它之前埋在 consumeStream 里 → 那个函数成了"解析 + 分发"两件事混在一起
 *   → 拆成三层：
 *     · useSseParser      —— 纯函数（字节 → 帧）可单测
 *     · useStreamRunner   —— 流的开销/取消/续传
 *     · useEventDispatcher —— 事件 → 状态（**只管这一件事**）✅
 *
 * ⚠️⚠️ 依赖用 ref 镜像（关键技术细节）：
 *   · dispatcher 需要 20+ 个 setter
 *   · 若直接放进 useCallback 的依赖数组 → 每次渲染都重建 dispatcher
 *     → 所有下游 useCallback（翻牌/追问/…）全部失效 → 性能退化
 *   → 用 \`paramsRef\` 存最新参数，dispatcher 本身**引用永不变** ✅
 *   → 消费方可以安全地把它放进依赖数组
 */

export interface DispatcherExtras {
  /** sessionId 的 ref 镜像（断点续传要读最新值） */
  sessionIdRef: React.RefObject<string>;
  /** delta 分流目标 */
  deltaTargetRef: React.RefObject<{
    type: "card" | "scroll" | "teller";
    entryId?: string;
  } | null>;
  /** delta 缓冲（只写不渲染） */
  deltaBufferRef: React.RefObject<{
    reading: string;
    card: { entryId: string; text: string } | null;
    scroll: { entryId: string; text: string } | null;
    teller: string | null;
  }>;
  /** 安排一次 delta flush */
  scheduleDeltaFlush: () => void;
  /** 生成下一个条目 id */
  nextEntryId: () => string;
  /** 追加一条对话流条目 */
  pushEntry: (e: Omit<FlowEntry, "id"> & { id?: string }) => string;
}

export type EventDispatcher = (p: AgentEventPayload) => void;

export function useEventDispatcher(
  state: DivinationStateApi,
  extras: DispatcherExtras
): EventDispatcher {
  /**
   * ⚠️⚠️ params 用 ref 镜像 —— 让 dispatcher 的引用**永不变**
   * ⚠️ 这样消费方（useStreamRunner / 各 useCallback）可以安全地依赖它
   */
  const paramsRef = useRef({ state, extras });
  paramsRef.current = { state, extras };

  return useCallback((p: AgentEventPayload) => {
    const s = paramsRef.current.state;
    const {
      setSessionId, setPhase, setPhaseLabel, setRateLimited, setReasoning,
      setTools, setRagHits, setSpread, setAsk, setFanCards, setFanCount,
      setEntries, setSubagentEvents, setPlanSteps, setPersonaSuggest,
      setRounds, setReview, setReading, setError, setCanFollowup,
    } = s;
    const {
      sessionIdRef, deltaTargetRef, deltaBufferRef, scheduleDeltaFlush,
      nextEntryId, pushEntry,
    } = paramsRef.current.extras;

`;

const footer = `
  }, []);
}
`;

writeFileSync(
  "src/features/divination/useEventDispatcher.ts",
  header + reindented + footer,
  "utf-8"
);
console.log("✓ 生成 useEventDispatcher.ts");
