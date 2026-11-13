"use client";

import { useCallback, useRef } from "react";

import { playSfx } from "@/lib/audio/ambient";

import type { FlowEntry } from "./types";
import type { AskPayload } from "./useDivinationState";

/**
 * useCardActions —— 翻牌 / 牌面预览 / 条目展开 / 选牌确认
 * （2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么这几件事该在一起：
 *   · 它们都围绕"牌"这一条主线：
 *     翻牌（flipCard）→ 牌面预览（openCardPreview）→ 展开解读（toggleEntry）
 *     → 确认选牌（confirmFanSelection）
 *   · 每一条都涉及 `spread`（牌阵）+ `entries`（对话流）两份状态的联动
 *   → 放在一起 → "牌的生命周期"在一个文件里看全 ✅
 *
 * ⚠️⚠️ 依赖设计：**不接收整个 state**，只接收用到的 setter
 *   · 依赖少 → useCallback 的依赖数组干净 → 引用真的稳定 ✅
 *   · 未来 page.tsx 改 state 结构时，这个 hook 不用动 ✅
 */

export interface CardActionsParams {
  /** 更新牌阵 */
  setSpread: (
    v:
      | import("./types").SpreadCard[]
      | ((prev: import("./types").SpreadCard[]) => import("./types").SpreadCard[])
  ) => void;
  /** 更新对话流条目 */
  setEntries: (v: FlowEntry[] | ((prev: FlowEntry[]) => FlowEntry[])) => void;
  /** 设置放大预览的牌 */
  setPreviewCard: (
    v: import("./types").PreviewCard | null | ((prev: import("./types").PreviewCard | null) => import("./types").PreviewCard | null)
  ) => void;
  /** 清空会话 id（会话失效时） */
  setSessionId: (v: string | ((prev: string) => string)) => void;
  /** 关闭追问入口 */
  setCanFollowup: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** 错误横幅 */
  setError: (v: string | ((prev: string) => string)) => void;
  /** 清空待回答的 HITL 问题（翻牌时收起） */
  setAsk: (v: AskPayload | null) => void;
  /** 轻提示 */
  setHint: (v: string | ((prev: string) => string)) => void;
  /** sessionId 的 ref 镜像 */
  sessionIdRef: React.RefObject<string>;
  /** 当前会话 id */
  sessionId: string;
  /** 提交选牌结果（发给后端） */
  answerAsk: (answer: string) => void | Promise<void>;
}

export interface CardActionsApi {
  /** 翻牌（POST /api/answer） */
  flipCard: () => Promise<void>;
  /** 放大预览已翻开的牌（只是看，不翻回去） */
  openCardPreview: (index: number) => void;
  /** 关闭放大预览 */
  closePreview: () => void;
  /** 展开/收起对话流条目 */
  toggleEntry: (entryId: string) => void;
  /** 确认选牌（扇面选择结果） */
  confirmFanSelection: (payload: string) => void;
}

export function useCardActions(params: CardActionsParams): CardActionsApi {
  const {
    setSpread,
    setEntries,
    setPreviewCard,
    setSessionId,
    setCanFollowup,
    setError,
    setAsk,
    setHint,
    sessionIdRef,
    sessionId,
    answerAsk,
  } = params;

  /** 翻牌请求 pending 标记（防连点：手快连点会发多个 /api/answer） */
  const flipPendingRef = useRef(false);

  /**
   * 翻牌
   *
   * ⚠️⚠️ 2026-11-04：本地乐观反馈
   * 用户实测报告："牌出现了，但有时候点的无效"。
   *   根因：点击 → POST → 等后端 200 → 等 SSE 的 card_reveal 事件到达
   *        → 牌面才变化。**网络慢时看起来就是"点了没反应"**。
   *   修法：点击**立刻**把该牌置为 `flipping`（本地状态）→
   *        播 3D 翻转动画 + "翻开中"遮罩 → 用户立刻有反馈。
   *   ⚠️ 落定仍由后端事件（card_reveal）负责 —— 乐观更新只是"提前回应"，
   *      不改变数据来源。如果后端最终失败，flipping 会被清掉。
   */
  const flipCard = useCallback(async () => {
    setAsk(null);
    // ⚠️ 翻牌音效：木质"嗒"—— 这是仪式里最有仪式感的一下，值得给声音
    void playSfx("flip");
    if (!sessionId) return;
    // 本地 pending：防连点（用户手快连点会发多个请求）
    if (flipPendingRef.current) return;
    flipPendingRef.current = true;

    setSpread((prev) => {
      const idx = prev.findIndex((c) => c.current);
      if (idx < 0) return prev;
      return prev.map((c, i) => (i === idx ? { ...c, flipping: true } : c));
    });

    /**
     * ⚠️ 2026-11-04：post 现在**同时返回状态码与错误体**
     *   原因：失败分支需要读后端的错误消息，而 body 一旦不被消费就取不到了。
     *   ⚠️ 之前那个分支是"再 fetch 一次拿错误"—— 那是**重复请求**（真 bug，已删）。
     */
    const post = async (): Promise<{ status: number; err: { error?: string } }> => {
      try {
        const res = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: "翻牌" }),
        });
        let err: { error?: string } = {};
        if (!res.ok) err = await res.json().catch(() => ({}));
        return { status: res.status, err };
      } catch {
        return { status: 0, err: {} };
      }
    };
    try {
      let { status, err } = await post();
      if (status === 409) {
        // ⚠️ 闸门未就绪（后端还在准备这张牌）→ 短暂等待后重试一次
        //   这是防御性兜底：正常不会走到这里（后端是"先建闸门、再发 ready"）。
        await new Promise((r) => setTimeout(r, 300));
        ({ status, err } = await post());
      }
      if (status === 409 || status === 410) {
        /**
         * ⚠️ 仍然失败（2026-11-04 改）
         * · 409 = 闸门未就绪 → **撤销乐观更新**（牌回到待命态），
         *   并给一个**可见**的提示（之前是静默失败 → 用户以为牌坏了）。
         * · 410 = 会话不可用 → 清本地 + **静默收起追问入口**
         */
        setSpread((prev) =>
          prev.map((c) => (c.flipping ? { ...c, flipping: false } : c))
        );
        if (status === 410) {
          try {
            localStorage.removeItem("tarot:sessionId");
          } catch {
            /* ignore */
          }
          setSessionId("");
          sessionIdRef.current = "";
          setCanFollowup(false);
          setError("");
        } else {
          // ⚠️ 409：可见提示（不是错误横幅，是轻提示）
          setHint("占卜师还在准备这张牌…稍等一下再点");
        }
      } else if (status !== 200) {
        // ⚠️⚠️ 2026-11-04 修一个真 bug：这里**又发了一次 POST**（重复请求）。
        //   正确做法：用 post() 已经带回来的错误体，不重发。
        setSpread((prev) =>
          prev.map((c) => (c.flipping ? { ...c, flipping: false } : c))
        );
        setError(err.error || "翻牌失败，请重试");
      }
    } catch {
      setSpread((prev) =>
        prev.map((c) => (c.flipping ? { ...c, flipping: false } : c))
      );
    } finally {
      flipPendingRef.current = false;
    }
  }, [
    sessionId,
    sessionIdRef,
    setAsk,
    setCanFollowup,
    setError,
    setHint,
    setSessionId,
    setSpread,
  ]);

  /**
   * 放大预览已翻开的牌（只是看，不翻回去）。
   * ⚠️ 牌名/牌面只在此刻可见 —— 未翻开的牌连名字都不给（防剧透）。
   */
  const openCardPreview = useCallback(
    (index: number) => {
      setSpread((prev) => {
        const c = prev[index];
        if (!c || !c.flipped) return prev;
        // 从对话流的牌面条目取牌意（牌阵面板只存了基础信息）
        setEntries((entriesNow) => {
          const cardEntry = [...entriesNow]
            .reverse()
            .find(
              (e) => e.kind === "card" && e.card?.cardIndex === index
            );
          setPreviewCard({
            nameZh: c.nameZh,
            image: c.image,
            reversed: c.reversed,
            pos: c.pos,
            meaning: cardEntry?.card?.meaning,
            done: c.done,
          });
          return entriesNow;
        });
        return prev;
      });
    },
    [setEntries, setPreviewCard, setSpread]
  );

  /** 关闭放大预览 */
  const closePreview = useCallback(() => setPreviewCard(null), [setPreviewCard]);

  /** 展开/收起条目 */
  const toggleEntry = useCallback(
    (entryId: string) => {
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, collapsed: !e.collapsed } : e))
      );
    },
    [setEntries]
  );

  /** 确认选牌（扇面选择结果 → 发给后端） */
  const confirmFanSelection = useCallback(
    (payload: string) => {
      // 选牌详情（"id,id,id|dwell,ms"）转为可读描述
      const [idsStr] = payload.split("|");
      const count = idsStr.split(",").filter(Boolean).length;
      const label =
        payload.trim() === "random" || count === 0
          ? "请星辰替我选（随机 3 张）"
          : `我亲手选了 ${count} 张牌`;
      // 把流内未 settle 的选牌 ask 条目固定为用户气泡
      setEntries((prev) => {
        const idx = [...prev]
          .reverse()
          .findIndex((e) => e.kind === "ask" && !e.settled && e.ask?.cardSelection);
        if (idx === -1) return prev;
        const realIdx = prev.length - 1 - idx;
        return prev.map((e, i) =>
          i === realIdx
            ? { ...e, settled: true, kind: "user", text: label, ask: undefined }
            : e
        );
      });
      answerAsk(payload);
    },
    [answerAsk, setEntries]
  );

  return {
    flipCard,
    openCardPreview,
    closePreview,
    toggleEntry,
    confirmFanSelection,
  };
}
