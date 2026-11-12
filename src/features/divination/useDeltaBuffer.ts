"use client";

import { useCallback, useEffect, useRef } from "react";

import type { FlowEntry } from "./types";

/**
 * useDeltaBuffer —— 流式 delta 的节流缓冲（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️⚠️ 为什么要这个 hook（性能关键）：
 *   · 流式 delta 每秒 20+ 事件
 *   · 逐条 `setEntries` 全量 map → 整页树**每秒重渲染 20+ 次**（长会话明显卡顿）
 *   → 改为：
 *     - delta 到达只写进 bufferRef（**零渲染成本**）
 *     - requestAnimationFrame 逐帧把缓冲一次性 flush 进 state
 *   · 一帧内的 N 条 delta 合并为 1 次 setState
 *   → 渲染次数从"每事件"降到"每帧" ✅
 *
 * ⚠️⚠️ 为什么缓冲分 4 个槽（reading / card / scroll / teller）：
 *   · 流式文本有**多个目的地**：
 *     · reading → 顶部的"命运之卷"正文
 *     · card    → 正在解读的那张牌
 *     · scroll  → "命运之卷 · 综合与收束"条目
 *     · teller  → 最后一个占卜师气泡（连续 delta 要拼接）
 *   → 每个槽独立缓冲 → 一帧内各自 flush 一次 ✅
 */

/** delta 缓冲的 4 个槽 */
interface DeltaBuffer {
  /** 顶部正文 */
  reading: string;
  /** 念牌/解读 → 某个 card 条目 */
  card: { entryId: string; text: string } | null;
  /** 综合与收束 → 某个 scroll 条目 */
  scroll: { entryId: string; text: string } | null;
  /** 占卜师气泡（连续 delta 要拼接） */
  teller: string | null;
}

export interface DeltaBufferApi {
  /** 缓冲区本体（SSE 消费时直接写入 delta，flush 时才进 state） */
  deltaBufferRef: React.RefObject<DeltaBuffer>;
  /**
   * 安排一次 flush（rAF 去重：同一帧只 flush 一次）
   *
   * ⚠️⚠️ 为什么**不**暴露 flushDeltaBuffer：
   *   · 它只在 scheduleDeltaFlush 内部被调用（外部没人用）
   *   · 暴露一个"看起来该用但实际不该手动调"的 API → 容易误用
   *     （比如在流结束后手动调 → 可能 flush 出半截数据）
   *   → 只暴露"安排 flush"这一个入口 ✅
   */
  scheduleDeltaFlush: () => void;
}

export function useDeltaBuffer(params: {
  /** 追加到顶部正文 */
  setReading: (value: string | ((prev: string) => string)) => void;
  /** 更新对话流条目 */
  setEntries: (value: FlowEntry[] | ((prev: FlowEntry[]) => FlowEntry[])) => void;
  /** 生成下一个条目 id（开新 teller 气泡时用） */
  nextEntryId: () => string;
}): DeltaBufferApi {
  const { setReading, setEntries, nextEntryId } = params;

  const deltaBufferRef = useRef<DeltaBuffer>({
    reading: "",
    card: null,
    scroll: null,
    teller: null,
  });
  const flushScheduledRef = useRef(false);
  /**
   * ⚠️ P2-㉒：rAF 的句柄 —— 组件卸载后必须 cancel。
   *   原来的 requestAnimationFrame(...) 没有句柄 → 卸载后仍会触发
   *   → flushDeltaBuffer 里的 setState 打到已卸载的组件（React 警告 + 泄漏）。
   */
  const flushRafRef = useRef<number | null>(null);

  const flushDeltaBuffer = useCallback(() => {
    flushScheduledRef.current = false;
    const buf = deltaBufferRef.current;
    if (buf.reading) {
      const d = buf.reading;
      setReading((prev) => prev + d);
      buf.reading = "";
    }
    if (buf.card) {
      const { entryId, text } = buf.card;
      if (text) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entryId && e.card
              ? { ...e, card: { ...e.card, reading: (e.card.reading ?? "") + text } }
              : e
          )
        );
      }
      buf.card = null;
    }
    if (buf.scroll) {
      const { entryId, text } = buf.scroll;
      if (text) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entryId ? { ...e, text: (e.text ?? "") + text } : e
          )
        );
      }
      buf.scroll = null;
    }
    if (buf.teller !== null) {
      const d = buf.teller;
      buf.teller = null;
      if (d) {
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          // 仅当最后一条就是 teller 气泡（连续 delta）才拼接；
          // 刚答完题（ask/user）或翻新牌后必须开新气泡
          if (last?.kind === "teller" && !last.settled) {
            return [...prev.slice(0, -1), { ...last, text: (last.text ?? "") + d }];
          }
          return [...prev, { id: nextEntryId(), kind: "teller", text: d }];
        });
      }
    }
  }, [nextEntryId, setEntries, setReading]);

  const scheduleDeltaFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    flushRafRef.current = requestAnimationFrame(() => flushDeltaBuffer());
  }, [flushDeltaBuffer]);

  // ⚠️ P2-㉒：卸载时取消待执行的 rAF（否则 setState 打到已卸载组件）
  useEffect(() => {
    return () => {
      if (flushRafRef.current != null) cancelAnimationFrame(flushRafRef.current);
    };
  }, []);

  return { deltaBufferRef, scheduleDeltaFlush };
}
