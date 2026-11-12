"use client";

import { useCallback, useRef } from "react";

import type { FlowEntry } from "./types";

/**
 * useFlowEntries —— 对话流（entries）的管理（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么单独抽出来：
 *   · entries 是整个占卜页面的**核心数据结构**（19 种条目类型：teller/user/ask/card/
 *     spread/scroll/nudge/…）
 *   · 它的操作（追加、更新、生成 id）散落在 SSE 消费、翻牌、追问等 5+ 处
 *   → 集中管理 → 一处改动全局生效 ✅
 *
 * ⚠️⚠️ 依赖极简（只有 setEntries）：
 *   → 不会被 eslint 的 exhaustive-deps 误判（它认识 useState 的 setter）✅
 *   → 依赖数组干净 → useCallback 真正有效 ✅
 */

/** delta 分流目标：当前 card / scroll / teller 条目的 id */
export type DeltaTarget = {
  type: "card" | "scroll" | "teller";
  entryId?: string;
} | null;

export interface FlowEntriesApi {
  /** 追加一条对话流条目，返回生成的 id */
  pushEntry: (e: Omit<FlowEntry, "id"> & { id?: string }) => string;
  /** 更新指定条目（支持传 patch 或 updater 函数） */
  updateEntry: (
    id: string,
    patch: Partial<FlowEntry> | ((e: FlowEntry) => Partial<FlowEntry>)
  ) => void;
  /** 生成下一个条目 id（`e1`、`e2`…） */
  nextEntryId: () => string;
  /** 重置 id 计数器（「重新开始」时调用 → 新会话的条目从 e1 重新开始） */
  resetEntryIds: () => void;
  /** delta 分流目标（ref：SSE 消费时写入，delta 到达时读取） */
  deltaTargetRef: React.RefObject<DeltaTarget>;
}

/**
 * ⚠️⚠️ 为什么 entries 本身**不**由这个 hook 持有：
 *   · entries 已经在 `useDivinationState` 里（和其他 33 个状态一起）→ 单一来源 ✅
 *   · 若这里再存一份 → 两个真相源 → 必然不同步 ❌
 *   → 本 hook 只接收 setEntries，专注"**怎么改**"，不碰"**是什么**" ✅
 */
export function useFlowEntries(
  setEntries: (
    value: FlowEntry[] | ((prev: FlowEntry[]) => FlowEntry[])
  ) => void
): FlowEntriesApi {
  /** 条目 id 计数器 */
  const entryIdRef = useRef(0);
  const nextEntryId = useCallback(() => `e${++entryIdRef.current}`, []);

  /** 重置 id 计数器（「重新开始」→ 新会话的条目从 e1 重新开始） */
  const resetEntryIds = useCallback(() => {
    entryIdRef.current = 0;
  }, []);

  /** delta 分流目标：当前 card 条目 id（念牌/解读 delta 流向这里） */
  const deltaTargetRef = useRef<DeltaTarget>(null);

  /** 追加一条对话流条目 */
  const pushEntry = useCallback(
    (e: Omit<FlowEntry, "id"> & { id?: string }) => {
      const id = e.id ?? nextEntryId();
      setEntries((prev) => [...prev, { ...e, id } as FlowEntry]);
      return id;
    },
    [nextEntryId, setEntries]
  );

  /** 更新指定条目 */
  const updateEntry = useCallback(
    (
      id: string,
      patch: Partial<FlowEntry> | ((e: FlowEntry) => Partial<FlowEntry>)
    ) => {
      setEntries((prev) =>
        prev.map((e) =>
          e.id === id
            ? { ...e, ...(typeof patch === "function" ? patch(e) : patch) }
            : e
        )
      );
    },
    [setEntries]
  );

  return {
    pushEntry,
    updateEntry,
    nextEntryId,
    resetEntryIds,
    deltaTargetRef,
  };
}
