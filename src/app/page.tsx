"use client";

import { useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import StardustCursor from "@/components/StardustCursor";
/**
 * ⚠️ 2026-11-05 视觉重设计：新的视觉基底
 *   · CelestialBackdrop —— 深空星云背景（含噪点/景深/暗角）
 *   · AstralCircle —— 真 SVG 星象魔法阵
 */
import CelestialBackdrop from "@/components/CelestialBackdrop";
import WitchOrb from "@/components/WitchOrb";
import AgentTrace from "@/components/AgentTrace";
import KnowledgePanel from "@/components/KnowledgePanel";
import CitedReading from "@/components/CitedReading";
import CardPreviewModal from "@/components/CardPreviewModal";
import DialogueFlow from "@/components/DialogueFlow";
import CardFan from "@/components/CardFan";
import ReviewCard from "@/components/ReviewCard";
import AmbienceToggle, { useAmbiencePhase } from "@/components/AmbienceToggle";
import ClosingPanel from "@/components/ClosingPanel";
import Icon from "@/components/icons";

/* ------------------------------------------------------------------ */
/* 代码分割（P2-⑯）                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ P2-⑯（第二轮优化分析 2026-11 ⑯）：这两个组件是**点开才用**的，
 *   但原来静态 import → 它们的代码进了**首屏 bundle**：
 *   · ShareCard —— Canvas 渲染逻辑 ~190 行（还带一套画布绘制工具函数）
 *   · SubAgentPipeline —— 流水线可视化
 *
 * ⚠️ 用 `next/dynamic` 拆出去 → 首屏 JS 变小，首屏渲染更快。
 * ⚠️ `ssr: false` 的原因：这两个组件都依赖浏览器 API
 *   （Canvas / document.fonts），服务端渲染没有意义。
 * ⚠️ 类型用 `import type` 单独引入 —— dynamic 拿不到类型。
 */


const ShareCardButton = dynamic(
  () => import("@/components/ShareCard").then((m) => m.default),
  { ssr: false, loading: () => null }
);
const SubAgentPipeline = dynamic(
  () => import("@/components/SubAgentPipeline").then((m) => m.default),
  { ssr: false, loading: () => null }
);
import { unlockAmbience, playSfx } from "@/lib/audio/ambient";
/* ---------------- 类型 ---------------- */

/**
 * ⚠️⚠️ 2026-11-12 拆分：类型与常量已移到 `src/features/divination/types.ts`
 * ⚠️ 为什么抽出去：
 *   · 这些类型被 UI 组件与 hooks 共同依赖 → 不能留在 page.tsx 里
 *   · 放在独立文件 → 依赖方向单向（components → hooks → types）→ 无循环依赖
 * ⚠️ 保留这些 import 是为了让下面的代码不用改（零行为变更）
 */
import { useDivinationState } from "@/features/divination/useDivinationState";
import { useFlowEntries } from "@/features/divination/useFlowEntries";
import { useDeltaBuffer } from "@/features/divination/useDeltaBuffer";
import { useStreamRunner } from "@/features/divination/useStreamRunner";
import { useCardActions } from "@/features/divination/useCardActions";
import { useFollowup } from "@/features/divination/useFollowup";
import HeroSection from "@/features/divination/components/HeroSection";
import EntryCards from "@/features/divination/components/EntryCards";
import DivinationInput from "@/features/divination/components/DivinationInput";
import StageProgress from "@/features/divination/components/StageProgress";
import {
  type FlowEntry,
} from "@/features/divination/types";


/* ---------------- 星空 & 魔法阵 ---------------- */


/**
 * 方向①：稳定用户标识（跨会话画像锚点）。
 * localStorage UUID：同一浏览器视为同一访客；隐私模式/无 localStorage 返回空（匿名）。
 */
function getUserKey(): string {
  try {
    let k = localStorage.getItem("tarot:userKey");
    if (!k) {
      k = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("tarot:userKey", k);
    }
    return k;
  } catch {
    return "";
  }
}

/**
 * 提取分享卡摘要：优先取"收束段"（最后一段，通常是占卜师的综合结论，
 * 分享价值最高），没有明确分段时取末尾 240 字。
 * 段标【牌面·…】与【启示】保留（它们在卡面上有视觉意义），【追问】/【补充】段剔除。
 */
function extractShareSummary(reading: string): string {
  if (!reading) return "";
  const paragraphs = reading
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("【追问】") && !p.startsWith("【补充】"));
  if (paragraphs.length === 0) return "";
  // 收束段：最后一段（若太短 < 40 字，往前再合一段）
  let summary = paragraphs[paragraphs.length - 1];
  if (summary.length < 40 && paragraphs.length >= 2) {
    summary = `${paragraphs[paragraphs.length - 2]}\n${summary}`;
  }
  // 仍超长 → 截到 360 字（卡面 8 行 × ~28px 字号约能放下）
  if (summary.length > 360) summary = summary.slice(0, 360) + "…";
  return summary;
}


/* ---------------- 主页面 ---------------- */

/**
 * ⚠️ 哪些阶段要播"锣"（阶段转换音效，2026-11-04）
 * ⚠️ 为什么只挑这几个：
 *   阶段事件在一次占卜里会触发很多次（每次工具调用都有 phase），
 *   全播就成噪音了。
 *   只在**用户能感知到的仪式节点**播 —— 让"推进"被听见。
 *
 * ⚠️ 为什么用数组而不是 Set：
 *   项目有一条硬规则（verify-runtime-state.mjs 守卫）：
 *   **模块级可变容器必须收敛到 globalThis**（否则 HMR 重置状态）。
 *   `new Set(...)` 会被守卫判为"未收敛的模块级可变状态"。
 *   → 用普通数组（const 声明、内容不变，Set 的 has → includes）。
 *   4 个元素的数组，includes 的性能差异可以忽略。
 *
 * ⚠️ 2026-11-12 拆分：常量已移到 `@/features/divination/types`（见上方 import）
 */

export default function TarotApp() {

  /**

   * ⚠️⚠️ 全部状态收进 useDivinationState（2026-11-12 拆分）

   * ⚠️ setter 的用法与原来的 useState **完全一致**（传值或传 updater 都行）

   * → 下面所有调用点无需改动 ✅

   */

  const stateApi = useDivinationState();
  const {

    question, setQuestion,
    persona, setPersona,

    mode, setMode,
    personas, setPersonas,

    stage, setStage,
    sessionId, setSessionId,

    phase, setPhase,
    phaseLabel, setPhaseLabel,

    rateLimited, setRateLimited,
    reading, setReading,

    reasoning, setReasoning,
    tools, setTools,

    rounds, setRounds,
    ragHits, setRagHits,

    ask, setAsk,
    fanCards, setFanCards,

    fanCount,
    followup, setFollowup,

    subagentEvents, setSubagentEvents,
    review, setReview,

    planSteps,
    personaSuggest, setPersonaSuggest,

    canFollowup, setCanFollowup,
    streaming, setStreaming,

    error, setError,
    hint, setHint,

    listening, setListening,
    streamStart, setStreamStart,

    thinkingElapsed, setThinkingElapsed,
    showDetails, setShowDetails,

    spread, setSpread,
    previewCard, setPreviewCard,

    interject, setInterject,
    entries, setEntries,
  } = stateApi;
  /**
   * ⚠️ 2026-11-04 双模式：占卜模式（快速一问 / 深度解读）
   * ⚠️ 默认「快速」—— 降低首次体验门槛（用户平均只花 45 秒），
   *   深度模式留给愿意等的人。
   */
  /**
   * 环境音：仪式阶段 → 氛围层的联动
   * ⚠️ 只在"占卜进行中"时启用 —— 待机页不该有声音。
   */
  useAmbiencePhase(phase, stage !== "input");
  /**
   * P2-⑪：当前是否处于"限速等待"
   * ⚠️ 与 phase 分开存 —— 它描述的是"等待的原因"而不是"流程处于哪一步"，
   *    两者会同时存在（我们既在某个阶段里，也在等限速配额）。
   */
  /* cards state 已删除：防剧透改造后 cards 事件是匿名槽位（image/nameZh 空），
     真实牌面状态在 spread 里（对话流牌阵 + 顶部时间线 + 分享卡共用） */
  /* 方向⑤：Plan-Execute 仪轨计划 + 情绪驱动人格建议 */
  /**
   * ⚠️ 追问是否可用（2026-11-04 新增）
   * ⚠️ 语义：会话**还在服务端内存里** → 追问能成功。
   *   内存会话有 30 分钟 TTL（session.ts 的 SESSION_TTL），
   *   过期后 POST /api/interpret 会返回 410。
   * ⚠️ 为什么前端要自己知道：
   *   落点卡片（ClosingPanel）要给"我想再问一句"一个真话，
   *   不能给一个必然失败的按钮 → 让用户白点一次、白失望一次。
   * ⚠️ 恢复会话时由服务端的 canFollowup 决定（见下面的 fetch 逻辑）。
   */
  /** 追问输入框的 ref（落点卡片的"我想再问一句"要聚焦它） */
  const followupInputRef = useRef<HTMLInputElement>(null);
  /** 分享卡区域的 ref（落点卡片的"保存解读卡片"要滚到它） */
  const shareCardRef = useRef<HTMLDivElement>(null);
  /**
   * ⚠️ 轻提示（2026-11-04 新增）
   * ⚠️ 与 error 的区别（这是刻意的）：
   *   · error    → **错误横幅**（红色）：出错了，用户需要知道出了什么问题
   *   · hint    → **轻提示**（柔和）：只是一句状态说明（如"稍等一下再点"）
   * ⚠️ 为什么需要它：翻牌 409 之前是**完全静默**的 → 用户以为牌坏了。
   *   但用 error 横幅又太重（那不是错误，只是"还没准备好"）。
   */
  /**
   * ⚠️ 思考计时（2026-11-04 新增）
   * ⚠️ 干什么用：给"占卜师思考中"气泡提供**持续变化的秒数**。
   *   · 它驱动气泡的显示门槛（≥1.2s 才出现）
   *   · 它驱动短句轮换（每隔几秒换一句）
   *
   * ⚠️ 实现方式（连踩了三次 React 19 的新规则才定下来的）：
   *   ① effect 里 setState(秒数)      → set-state-in-effect 规则拒绝
   *   ② 渲染期读 ref                  → react-hooks/refs 规则拒绝
   *   ③ 渲染期调 Date.now()           → react-hooks/purity 规则拒绝
   *   → **正解**：秒数就是 state，由**定时器回调**更新。
   *     React 允许在事件/定时器回调里 setState（那才是正常的数据流方向），
   *     被拒的只是"effect 里同步 setState"。
   */
  useEffect(() => {
    if (!streaming) {
      // ⚠️ 这里 setState(0) 也会被规则拒 → 改为**不在 effect 里同步设**，
      //   而是用下面的定时器首拍来归零（定时器回调里 setState 是允许的）。
      const t = setTimeout(() => setThinkingElapsed(0), 0);
      return () => clearTimeout(t);
    }
    const t0 = Date.now();
    const timer = setInterval(() => {
      setThinkingElapsed(Math.floor((Date.now() - t0) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [streaming]);
  /** 过程细节区展开态（默认折叠 = 零渲染开销） */
  /* ---- 真实塔罗仪式流程状态（仅保留仍在使用的部分；仪式对话已并入对话流）---- */
  /** 逐张解读的牌阵状态（顶部时间线与对话流牌阵**共用这一份** → 天然同步） */
  /** 放大预览的牌（null = 未打开） */
  /** 用户插话（方案 C） */
  /* ---- 对话流（统一视图）---- */
  /**
   * sessionId 的 **ref 镜像**（P0-③）
   *
   * ⚠️ 为什么需要 ref 镜像（这是断点续传从"写了但从没用过"变成真能用的关键）：
   *   `startDivination` 是 useCallback，它捕获的 `sessionId` 是**创建那一刻**的值。
   *   而 session id 是 SSE 流中途才写进来的（case "session" → setSessionId）。
   *   于是 catch 块里的 `if (sessionId && lastSeqRef.current > 0)`
   *   读到的永远是**启动时的空串** → 恢复分支**一次都进不去**。
   *
   *   同一个恢复逻辑里 `lastSeqRef` 用 ref（正确）、`sessionId` 用 state（错误）——
   *   混用导致语义不一致。
   *   修法：sessionId 也用 ref 读，与 lastSeqRef 对齐。
   */
  const sessionIdRef = useRef("");
  /**

   * ⚠️⚠️ 对话流条目管理（2026-11-12 拆分 → useFlowEntries）

   * ⚠️ 依赖只有 setEntries → 不会被 eslint 误判为不稳定 ✅

   */

  const { pushEntry, updateEntry, nextEntryId, resetEntryIds, deltaTargetRef } =

    useFlowEntries(setEntries);


  /**

   * ⚠️⚠️ delta 节流缓冲（2026-11-12 拆分 → useDeltaBuffer）

   * ⚠️ 流式 delta 每秒 20+ 事件 → 必须 rAF 批量合并，否则整页每秒重渲染 20+ 次

   */

  const { deltaBufferRef, scheduleDeltaFlush } = useDeltaBuffer({

    setReading,

    setEntries,

    nextEntryId,

  });

  /**
   * ⚠️⚠️ SSE 流：消费 / 事件分发 / 取消 / 断点续传（2026-11-12 → useStreamRunner）
   * ⚠️ 内部含 19 种协议事件的 switch（420 行）→ 那一大块搬走了
   * ⚠️ 必须在 useFlowEntries / useDeltaBuffer **之后**调用（它依赖它们的返回值）
   */
  const { consumeStream, abortStream, resumeStream, fetchStream, lastSeqRef } =
    useStreamRunner(stateApi, {
      sessionIdRef,
      deltaTargetRef,
      deltaBufferRef,
      scheduleDeltaFlush,
      nextEntryId,
      pushEntry,
    });


  /**
   * 回答对话流中的 ask 条目：条目转 settled（用户气泡），并发送 API。
   * card 条目的确认问题走 answerCardConfirm（挂在 card 上）。
   * flip 型（轮到你翻牌）也走这里 —— 插话内容会被后端记入 interjections。
   */
  const answerFlowAsk = useCallback(async (entryId: string, answer: string) => {
    // 条目固定为用户气泡
    updateEntry(entryId, { settled: true, kind: "user", text: answer, ask: undefined });
    setAsk(null);
    if (!sessionId) return;
    // 呼召走多答案接口
    const isInvocation = answer.includes("\n");
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isInvocation ? { sessionId, answers: answer.split("\n") } : { sessionId, answer }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "回应失败" }));
        setError(err.error || "回应发送失败，请重试");
      }
    } catch {
      setError("回应发送失败，请重试");
    }
  }, [sessionId, updateEntry]);

  /** 回答 card 条目上的确认问题 */
  const answerCardConfirm = useCallback(async (entryId: string, answer: string) => {
    // 答案挂到牌上（流内显示为该牌的用户气泡），占卜师随后开始讲透这张牌
    updateEntry(entryId, (e) => (e.card ? { card: { ...e.card, answer } } : {}));
    /**
     * ⚠️⚠️ 2026-11-04 新增：答案同步回**牌阵条目**
     *
     * ⚠️ 为什么必须同步：
     *   SpreadPanel 的 `hasPendingCardQuestion` 判据是
     *   「牌已翻开 + 有 question + **没有 answer**」。
     *   不同步 answer → 牌阵会一直保持展开（挡住了正文），
     *   而用户已经答完了。
     *   ⚠️ 这是"收起/展开"两个方向的对称要求：
     *     提问时同步 question → 展开；回答时同步 answer → 可收起。
     */
    setEntries((prev) =>
      prev.map((e) =>
        e.kind === "spread" && e.spread
          ? {
              ...e,
              spread: e.spread.map((c) =>
                // ⚠️ 只填"有 question 且还没 answer"的那张（= 刚被问的那张）
                c.question && !c.answer ? { ...c, answer } : c
              ),
            }
          : e
      )
    );
    setAsk(null);
    if (!sessionId) return;
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "回应失败" }));
        setError(err.error || "回应发送失败，请重试");
      }
    } catch {
      setError("回应发送失败，请重试");
    }
  }, [sessionId, updateEntry]);



  /* 拉取人格列表 + 恢复上次会话（刷新后 sessionId 从 localStorage 找回，
   * "追问"仍可用——十几分钟的仪式流程不因刷新作废） */
  useEffect(() => {
    fetch("/api/personas")
      .then((r) => r.json())
      .then((d) => setPersonas(d.personas ?? []))
      .catch(() => {});
    // 会话恢复：localStorage 是外部系统，用微任务回填（避免 effect 内同步 setState 的级联渲染）
    Promise.resolve().then(() => {
      try {
        const saved = localStorage.getItem("tarot:sessionId");
        if (!saved) return;
        /**
         * ⚠️ 会话存活探测（2026-11-04 改为按 canFollowup 判断）
         *
         * ⚠️ 之前的 bug（用户实测报告）：
         *   原来只判 `r.ok`（HTTP 200）就回填 sessionId → 显示"可追问"面板。
         *   但 /api/session/[id] 对**两类**会话都返回 200：
         *     ① 内存活跃会话 → 能追问 ✅
         *     ② DB 里已完成的会话（内存已被 cleanExpired 逐出）→ **追问必然 410** ❌
         *   → 用户一点追问就撞"超过 30 分钟"（其实会话是正常完成的）
         *
         * ⚠️ 现在服务端显式返回 canFollowup（"能不能追问"是服务端的事实），
         *   前端不再从 status 猜。
         */
        fetch(`/api/session/${saved}`)
          .then(async (r) => {
            if (!r.ok) {
              // 会话不存在 → 清本地，不展示追问入口
              try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
              setSessionId("");
              sessionIdRef.current = "";
              return;
            }
            const data = await r.json().catch(() => ({}));
            if (data.canFollowup) {
              // ⚠️ 能追问 → 回填（会话还在内存里）
              setSessionId((cur) => (cur ? cur : saved));
              sessionIdRef.current = saved; // P0-③：同步 ref（恢复的会话也要能断点续传）
              setCanFollowup(true);
            } else {
              /**
               * ⚠️ 不能追问（会话已完成/已被逐出）：
               *   · **清掉 localStorage**（否则下次进来还会重复探测）
               *   · **不回填 sessionId** → "可追问"面板不会渲染
               *   · ⚠️ 但**不报错** —— 用户刷新后仍应能看到完整解读（正文在 DB 里），
               *     报"已过期"会让人误以为内容丢了。
               */
              try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
              setSessionId("");
              sessionIdRef.current = "";
              setCanFollowup(false);
            }
          })
          .catch(() => {
            // 探测失败（网络/服务未就绪）：保守起见不回填（宁可让用户重新开始）
            try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
            setCanFollowup(false);
          });
      } catch { /* 隐私模式 */ }
    });
  }, []);

  /**
   * 轻提示自动消失（2026-11-04）
   *
   * ⚠️ 为什么要有自动消失：
   *   轻提示是"状态说明"，不是"要用户处理的事"——
   *   让它一直挂着会变成噪音（尤其在等待期反复出现）。
   *   3.5 秒足够读完一行短句，又不会让人觉得"界面卡着不动"。
   */
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(""), 3500);
    return () => clearTimeout(t);
  }, [hint]);

  /**
   * 组件卸载时中断在途的 SSE 请求（P0-③）
   *
   * ⚠️ 为什么必须做：
   *   用户关掉标签页 / 刷新 → 前端的 fetch 被浏览器取消，
   *   但**后端**不知道（除非 req.signal 触发）。
   *   不主动 abort 的话，后端会继续跑完整场仪式。
   *   有了这个 cleanup，浏览器发 abort → req.signal 触发
   *   → 后端标记 client_disconnect → 停止烧 token。
   */
    // ⚠️ 组件卸载时中止在途的 SSE 请求
    useEffect(() => {
      return () => {
        abortStream();
      };
    }, [abortStream]);

  /* SSE 消费 */
  /**
   * SSE 消费 —— 支持断点续传（P1-③D）
   *
   * ⚠️ 断流恢复：
   *   后端给每个事件带 SSE 标准 `id: <seq>` 字段。
   *   这里记录最后收到的 seq；流意外中断时（网络抖动），
   *   用 `Last-Event-ID` + `resume: true` 请求后端补发缺失事件。
   *
   * ⚠️ 为什么不用 EventSource：
   *   EventSource 只能 GET，不能带自定义 body（POST /api/interpret）。
   *   所以用 fetch + ReadableStream 手动解析 SSE 帧。
   */
  /* 开始占卜 */
  const startDivination = useCallback(async () => {
    // ⚠️ 连点防护：流式进行中再触发会并发两个 SSE 流交错写同一批 state
    if (streaming) return;
    const q = question.trim();
    if (!q) {
      setError("请先在心中默念并写下你的问题 ✦");
      return;
    }
    /**
     * ⚠️ 环境音解锁 —— 必须在这里（**用户手势的同步调用栈内**）
     *   浏览器禁止无手势的音频自动播放；这个 async 回调由按钮 onClick 触发，
     *   所以此刻仍处于"用户手势"上下文，AudioContext.resume() 才会成功。
     *   ⚠️ 不 await —— 音频解锁失败不该阻塞占卜开始。
     */
    void unlockAmbience().then(() => playSfx("chime"));
    setError("");
    setReading("");
    setReasoning("");
    setTools([]);
    setRounds([]);
    setRagHits([]);
    setAsk(null);
    setFanCards([]);
    setSubagentEvents([]);
    setReview(null);
    setPhase(null);
    setPhaseLabel("");
    setRateLimited(false); // P2-⑪：新一场占卜重置限速标记
    /* 仪式流程状态重置 */
    setSpread([]);
    setInterject("");
    /* 对话流重置：用户的问题作为第一条气泡 */
    setEntries([{ id: nextEntryId(), kind: "user", text: q } as FlowEntry]);
    deltaTargetRef.current = null;
    lastSeqRef.current = 0; // 新一场占卜 → 断点续传序号归零
    setStage("drawing");
    setStreaming(true);
    setStreamStart(Date.now());

    try {
      // P0-③：给这次请求挂上 AbortController
        // ⚠️ 用 fetchStream（内部处理 AbortController + 取消上一个流）
        const res = await fetchStream(
          "/api/interpret",
          { question: q, persona: persona?.id, userKey: getUserKey(), mode }
        );
      await consumeStream(res);
    } catch (e) {
      // ⚠️ P0-③：主动取消（用户点了「重新开始」）不是错误 —— 静默返回
      if (e instanceof DOMException && e.name === "AbortError") {
        setStreaming(false);
        return;
      }
      // ⚠️ 断流恢复（P1-③D）：网络抖动导致流中断时，
      //    尝试用 Last-Event-ID 让后端补发缺失事件。
      //    前提：已经收到过至少一个事件（seq>0）且知道 sessionId
      //    —— 否则是"服务端一开始就没响应"，重连也没用。
      //
      // ⚠️ P0-③：sessionId 必须读 **ref**（sessionIdRef.current）——
      //    这里在同一次调用栈内，state 闭包捕获的是启动时刻的空串，
      //    恢复分支永远进不去（断点续传功能写了两轮却从未真正生效）。
      const msg = e instanceof Error ? e.message : "解读失败";
      const sid = sessionIdRef.current;
      if (sid && lastSeqRef.current > 0) {
        setError("连接中断，正在恢复对话…");
        const ok = await resumeStream();
        if (ok) {
          setError("");
          setStreaming(false);
          return;
        }
      }
      setError(`${msg}，请重试`);
    } finally {
      setStreaming(false);
    }
  }, [question, persona, mode, consumeStream, streaming, resumeStream, abortStream, fetchStream]);

  /* HITL 应答（选牌扇面 / 随机代抽等仍在流外的交互）。
     ⚠️ 提交锁：双击选项/按钮会双发 POST，第二次 409 报错干扰用户 */
  const answeringRef = useRef(false);
  const answerAsk = useCallback(async (answer: string) => {
    if (!answer.trim() || !sessionId) return;
    if (answeringRef.current) return; // 防连点
    answeringRef.current = true;
    setAsk(null);
    // ⚠️ 答问音效：温和的确认音 —— 呼应"占卜师听见了你"
    void playSfx("answer");
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer: answer.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "回应失败" }));
        setError(err.error || "回应发送失败，请重试");
      }
    } catch {
      setError("回应发送失败，请重试");
    } finally {
      answeringRef.current = false;
    }
  }, [sessionId]);

  /**
   * ⚠️⚠️ 牌的操作：翻牌 / 预览 / 展开 / 选牌确认（2026-11-12 → useCardActions）
   * ⚠️ 依赖只传用到的 setter → useCallback 依赖干净、引用真的稳定 ✅
   */
  const { flipCard, openCardPreview, closePreview, toggleEntry, confirmFanSelection } =
    useCardActions({
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
    });

  /**
   * ⚠️⚠️ 追问 / 插话 / 语音（2026-11-12 → useFollowup）
   * ⚠️ 三条追加输入通道语义一致（共享连点防护与 410 处理）→ 放一起 ✅
   */
  const { sendInterjection, sendFollowup, startVoice } = useFollowup({
    sessionId,
    sessionIdRef,
    streaming,
    followup,
    setFollowup,
    interject,
    setInterject,
    pushEntry,
    setReading,
    setStreaming,
    setStreamStart,
    setError,
    setSessionId,
    setCanFollowup,
    setQuestion,
    setListening,
    deltaTargetRef,
    fetchStream,
    consumeStream,
  });





  const restart = useCallback(() => {
    // ⚠️ P0-③：先中断在途的 SSE 请求
    //    不中断的话，旧占卜会继续跑完整场仪式（14 次 LLM 往返），
    //    白烧约 ¥0.22 的 token，而且后端还把它记成"正常完成"。
    abortStream();
    setStage("input");
    setSessionId("");
    sessionIdRef.current = ""; // P0-③：同步清 ref（否则恢复逻辑会指向已放弃的会话）
    // ⚠️ 2026-11-04：重置追问可用性（新会话还没建立 → 追问不可用，
    //   等 session 事件到达后由 setCanFollowup(true) 打开）
    setCanFollowup(false);
    try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
    setQuestion("");
    setReading("");
    setReasoning("");
    setTools([]);
    setRounds([]);
    setRagHits([]);
    setAsk(null);
    setFanCards([]);
    setSubagentEvents([]);
    setReview(null);
    setPhase(null);
    setPhaseLabel("");
    setRateLimited(false); // P2-⑪：新一场占卜重置限速标记
    /* 仪式流程状态重置 */
    setSpread([]);
    setInterject("");
    /* 对话流重置 */
    setEntries([]);
    deltaTargetRef.current = null;
    resetEntryIds();
    setError("");
    setStreaming(false);
  }, [abortStream]);

  const done = phase === "done" && !streaming;

  return (
        /**
     * ⚠️⚠️ pt 用 `calc(... * var(--u))`（基准 48px）
     * → 与背景图、文字一起等比缩放 → 构图比例一致 ✅
     */
    <main
      className="relative min-h-[100dvh] overflow-hidden flex flex-col items-center px-4"
      style={{ paddingTop: "calc(48px * var(--u, 1))" }}
    >
      {/*
        ⚠️⚠️ 为什么是 min-h-[100dvh] 而不是 min-h-screen（2026-11-04 修滚动条）：
          · `100vh` 在 CSS 里**包含滚动条高度**，而 <html class="h-full"> 用的是
            **视口高（不含滚动条）** —— 两者叠加 → 多出滚动条的高度 →
            **全屏页面出现右侧滚动条**。
          · `dvh`（dynamic viewport height）**不含滚动条**，且：
            - 移动端浏览器地址栏收放时自动跟随（100vh 不会）
            - 软键盘弹出时跟随 visual viewport（iOS Safari 的 100vh 是最大视口高，
              键盘弹出时不缩小 → 布局留一大块空白）
          · 兼容性：Chrome 108+ / Safari 15.4+ / Firefox 101+（2022 年后全支持）；
            兜底见 globals.css 的 @supports not (height: 100dvh)。
      */}
      <StardustCursor />
      {/**
       * ⚠️ 2026-11-05 视觉重设计：星云背景 + 真 SVG 魔法阵。
       * ⚠️ ⚠️ 魔法阵**由 CelestialBackdrop 承载**（作为它的第 8 层）：
       *   页面级定位（absolute/fixed + 百分比）会因为祖先的 transform /
       *   filter / backdrop-filter 而偏移 —— 实测连试三种都跑偏。
       *   → 让已经是 inset-0 的背景层做 flex 居中 → 位置永远正确。
       * ⚠️ active：占卜进行中 → 魔法阵亮起（视觉上"仪式在运转"）。
       */}
      {/**
       * ⚠️ 2026-11-06：接入 AI 生成的背景素材。
       * · 背景图：真实星云（AI 生成，23KB WebP）—— CSS 渐变做不出絮状结构
       * · 魔法阵：AI 生成的古典星盘刻蚀图（比 CSS SVG 精细几个量级）
       * ⚠️ 魔法阵的 opacity 由 CelestialBackdrop 内部乘 0.3 → 保持"淡"
       */}
      <CelestialBackdrop
        showCircle
        circleSize={620}
        circleIntensity={0.72}
        circleActive={stage !== "input"}
        image="/images/celestial/bg-home.webp"
        imagePosition="center center"
        circleImage="/images/celestial/magic-circle.png"
      />

      {/* ---------- 环境音控制（固定右上角）----------
        ⚠️ 位置选择：固定在视口右上 —— 它是全局设置而不是内容流的一部分，
           不该随页面滚动（占卜页会很长，滚下去就找不到了）。
           ⚠️ z-30 盖在魔法阵之上，但不遮挡任何交互区（右上角是空的）。
        ⚠️ 2026-11-04 三改：这里只挂一个按钮（Windows 任务栏式的音量飞出窗），
           首次提示气泡（点击开启氛围乐）也由 AmbienceToggle 内部渲染。 */}
      <div className="fixed right-4 top-4 z-30">
        <AmbienceToggle />
      </div>

      {/* ---------- 首页入场：点击开启占卜之声 ----------
        ⚠️ 浏览器禁止无手势的音频自动播放 → 必须有一次真实的点击。
           这个组件把解锁包装成入场仪式（不是丑陋的遮罩）。
        ⚠️ 2026-11-04 三改：底部大提示 + 悬浮月亮（AmbienceGate）已删除，
           首次提示改由右上角按钮旁的气泡承担（见 AmbienceToggle）。 */}
      {/* 标题 */}
      <HeroSection />

      {/* ══════════════════════════════════════════════
       * 小女巫水晶球 · 单图方案（2026-11-10）
       *
       * ⚠️ 用户最终要求（原文）：
       *   「其实我是想都做成一张底图的 只有球在发光 然后跟着背景走
       *     现在背景移动了球移动但是 底部的小女孩还在
       *     一张图 只有球发光」
       *
       * ⚠️⚠️ WitchOrb 现在**完全由 fixed 图层组成**：
       *   · 背景层 = 小女孩 + 球（一张图，半透明当底图）
       *   · 发光层 = 只有球的位置在发光（CSS 叠加，跟随背景）
       *   → **不占布局位置** → 放在这里只是决定 z 顺序
       *
       * ⚠️ 为什么放在 CelestialBackdrop **之后**：
       *   · CelestialBackdrop 是星空底图（z-auto，最底）
       *   · WitchOrb 的背景层要浮在星空之上 → 必须在它之后渲染
       *   · 内容是 z-10 → 小女孩和光晕都在内容之下，不挡交互
       */}
      <WitchOrb />

      {/* ══════════════════════════════════════════════
       * ⚠️⚠️ 球的占位区（2026-11-12）
       *
       * ⚠️ 用户要求（原文）：
       *   「球的部分那块空出来的 标题下面是球 这块部分不要文字
       *     文字放在球高度结束下面」
       *
       * ⚠️⚠️ 为什么需要这个占位块：
       *   · WitchOrb 的两层都是 absolute → **不占布局位置**
       *   → 球会和下面的内容（入口卡片、占卜师头像）**重叠**（实测 v79）
       *   → 这个占位块从文档流里**空出球的高度** → 下面所有内容自动下移 ✅
       *
       * ⚠️ 高度怎么算：
       *   球的显示直径 = (BALL_R×2 / 1024) × S，S = min(112vw, 100vh)
       *   → 在 CSS 里无法直接表达（要算 min）→ 用**同源的 CSS 变量**
       *   → WitchOrb 里也用同一个变量算球的实际位置 → 天然对齐 ✅
       */}
      <div
        data-orb-slot
        aria-hidden="true"
        className="w-full shrink-0"
        style={{ height: "var(--orb-slot-h, 324px)" }}
      />

      {/* ---------- 运势入口（2026-11-04 C 方向 · 2026-11-05 视觉重设计）----------
          ⚠️ 竞品对标：Tarot Run 的顶栏有「每日塔罗」，Tarotap 有 5 种运势。
          ⚠️ 为什么放在副标题下（而不是右上角）：
            右上是音乐按钮（固定不动），这里是**内容流**的一部分 ——
            用户刚进站、正准备提问，此时看到"今天也有牌"能降低"必须提问才能用"的门槛。
          ⚠️ 2026-11-05：从「文字胶囊」改成「图标卡片」——
            胶囊只有一行小字，在深色背景上几乎看不见（截图实测）；
            卡片有图标 + 标题 + 说明 → 既是入口，也是产品能力的展示。 */}
      {stage === "input" && <EntryCards />}

      {/* ---------- 输入阶段 ---------- */}
      {stage === "input" && (
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7 }}
          className="w-full max-w-xl z-10"
        >
            <DivinationInput
              personas={personas}
              persona={persona}
              onSelectPersona={setPersona}
              mode={mode}
              onChangeMode={setMode}
              question={question}
              onChangeQuestion={setQuestion}
              onClearError={() => setError("")}
              onStart={startDivination}
              onVoice={startVoice}
              listening={listening}
            />
          {error && (
            <div className="mt-3 flex items-center gap-2 text-purple-400/90 text-sm text-center sm:text-left">
              <Icon name="orbit" size={15} />
              <p className="flex-1">{error}</p>
              {/* 过期/出错时给唯一出路：一键重开（清空会话与本地记录） */}
              <button
                onClick={restart}
                className="shrink-0 px-4 py-1.5 rounded-xl border border-purple-400/40 text-purple-200 text-xs hover:bg-purple-900/30 transition-all"
              >
                重新开始
              </button>
            </div>
          )}
          {/**
           * ⚠️ 轻提示（2026-11-04 新增）
           *   与 error 横幅**刻意区分**：
           *   · error → 红色警示 + 「重新开始」按钮（出错，需要用户处理）
           *   · hint  → 柔和单行（只是一句状态说明，3.5s 自动消失）
           * ⚠️ 为什么要它：翻牌 409（闸门还没就绪）之前是**完全静默**的 →
           *   用户以为牌坏了。现在至少告诉他"稍等一下再点"。
           */}
          {hint && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-3 text-center text-xs text-purple-300/70 tracking-wide"
            >
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-purple-400/20 bg-purple-950/30">
                <span className="w-1 h-1 rounded-full bg-purple-300/70 animate-pulse" />
                {hint}
              </span>
            </motion.div>
          )}
          {/* 上次会话可继续（刷新后 sessionId 已从 localStorage 恢复）。
              ⚠️ 2026-11-04：恢复时按服务端的 canFollowup 判断（不是"有 sessionId 就行"）——
                 DB 里已完成/已被逐出的会话会返回 canFollowup=false →
                 不回填 sessionId → 这个面板**不会渲染** → 用户不再撞 410。 */}
          {sessionId && !streaming && !error && (
            <div className="mt-4 rounded-2xl border border-purple-500/25 bg-purple-950/20 px-4 py-3 text-center">
              <p className="text-xs text-purple-300/60 mb-2">检测到上次未完结的占卜，可以直接追问（不用重新走仪式）</p>
              <div className="flex gap-2 justify-center">
                <input
                  className="flex-1 max-w-xs px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-500/30 text-purple-50 placeholder-purple-300/40 focus:outline-none focus:border-purple-400/60 text-sm"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                  placeholder="继续问点什么…"
                  aria-label="追问占卜师"
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendFollowup()}
                  maxLength={150}
                />
                <button
                  onClick={() => { setStage("reading"); sendFollowup(); }}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm"
                >
                  追问
                </button>
              </div>
            </div>
          )}
          <p className="mt-5 text-center text-[rgba(196,181,253,0.60)] text-sm tracking-wide">
            {persona ? `${persona.emoji} ${persona.name}将主持这场占卜` : "AI 占卜师与你对话澄清 · 亲手选牌 · 典籍引用 · 审校质检"}
          </p>
        </motion.div>
      )}

      {/* ---------- 占卜阶段 ---------- */}
      {stage !== "input" && (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-4xl z-10 flex flex-col items-center"
        >
          <StageProgress
            spread={spread}
            onFlipCard={flipCard}
            onPreview={openCardPreview}
            phase={phase}
            phaseLabel={phaseLabel}
            streaming={streaming}
            hasAsk={!!ask}
            streamStart={streamStart}
            rateLimited={rateLimited}
            planSteps={planSteps}
          />

          {/* ---------- 对话流主体（问题与回答同区，逐张解读可折叠）---------- */}
          <DialogueFlow
            entries={entries}
            onAskAnswer={answerFlowAsk}
            onCardAnswer={answerCardConfirm}
            onToggleEntry={toggleEntry}
            onFlipCard={flipCard}
            onPreviewCard={openCardPreview}
            streaming={streaming}
            waitingUser={phase === "wait_user"}
            /** ⚠️ 思考气泡的三个输入（2026-11-04） */
            thinkingPhase={phase}
            thinkingElapsed={thinkingElapsed}
            thinkingRound={rounds.length}
          />

          {/* 选牌扇面（cardSelection 是特殊交互，保留在流外） */}
          {ask?.cardSelection && fanCards.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full max-w-2xl mt-4">
              <CardFan cards={fanCards} count={fanCount} onConfirm={confirmFanSelection} />
            </motion.div>
          )}
          {ask?.cardSelection && fanCards.length === 0 && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-xl mt-6 rounded-3xl border border-emerald-500/30 bg-emerald-950/15 backdrop-blur-md p-6 text-center"
            >
              <p className="text-lg text-purple-50/95 mb-4" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
                {ask.question}
              </p>
              <p className="text-xs text-emerald-200/60 animate-pulse">命运之牌正在洗牌归位…（扇面数据未送达，已请求降级选牌）</p>
              <button
                onClick={() => confirmFanSelection("random")}
                className="mt-4 px-6 py-3 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm"
              >
                ✦ 代替我随机抽 3 张
              </button>
            </motion.div>
          )}

          {/* ---------- 错误常驻出口（流中断/应答失败时可见 + 可恢复）---------- */}
          {error && !streaming && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 w-full max-w-2xl rounded-2xl border border-rose-500/40 bg-rose-950/20 backdrop-blur-md px-4 py-3 flex items-center gap-3"
            >
              <Icon name="orbit" size={15} className="text-purple-400/80 shrink-0" />
              <p className="flex-1 text-sm text-rose-200/90">{error}</p>
              <button
                onClick={restart}
                className="shrink-0 px-4 py-2 rounded-xl border border-rose-400/40 text-rose-100/90 text-sm hover:bg-rose-900/30 transition-all"
              >
                重新开始
              </button>
            </motion.div>
          )}

          {/* ---------- 插话输入（对话流下方，随时可补充）---------- */}
          {(spread.length > 0 || streaming) && !ask && (
            <div className="mt-3 w-full max-w-2xl flex gap-2">
              <input
                value={interject}
                onChange={(e) => setInterject(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendInterjection()}
                maxLength={120}
                placeholder="想补充点什么？占卜师会听到…"
                aria-label="插话补充"
                className="flex-1 px-4 py-2.5 rounded-xl bg-purple-950/25 border border-purple-500/20 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-purple-400/50 transition-all text-sm"
              />
              <button
                onClick={sendInterjection}
                disabled={!interject.trim()}
                className="px-4 py-2.5 rounded-xl border border-purple-400/35 text-purple-200 text-sm disabled:opacity-35 hover:bg-purple-900/40 transition-all"
              >
                插话
              </button>
            </div>
          )}

          {/* ---------- 追问 / 分享（完成态）---------- */}
          {done && sessionId && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-2xl mt-5">
              {/**
               * ⚠️⚠️ 收束落点卡片（2026-11-04 新增）
               * ⚠️ 用户实测报告："综合与收束那里，我每次回答完问题，都是停在那里了…
               *   需要用户有输入的时候，他能接上话…不要让用户停在那里"。
               *
               * ⚠️ 为什么放在**追问框上面**：
               *   原先完成态只有一个追问输入框（用户要自己想到"我可以追问"）。
               *   现在先给一张卡片明确"接下来你可以做什么"，
               *   追问框作为其中一条路径。
               *
               * ⚠️ canFollowup 的来源：会话还在服务端内存里才能追问。
               *   内存会话有 30 分钟 TTL（session.ts 的 SESSION_TTL）——
               *   超过后追问会 410。所以这个按钮必须知道真话。
               */}
              <ClosingPanel
                canFollowup={canFollowup}
                onAskAgain={() => {
                  // ⚠️ 点"我想再问一句" → 聚焦到下面的追问框
                  followupInputRef.current?.focus();
                  setHint("写下你的追问，占卜师在听…");
                }}
                onShare={() => {
                  // ⚠️ 滚动到分享卡区域（ShareCardButton 在下面）
                  shareCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                onSwitchPersona={() => {
                  const found = personas.find((p) => p.id === personaSuggest?.personaId);
                  if (found) {
                    setPersona(found);
                    setPersonaSuggest(null);
                  }
                }}
                onRestart={restart}
                personaSuggest={personaSuggest}
              />
              {/* 方向⑤：情绪驱动的人格建议（下一场入口） */}
              {personaSuggest && (
                <div className="mb-5 rounded-2xl border border-amber-500/30 bg-amber-950/10 backdrop-blur-md px-5 py-4 flex items-start gap-4">
                  <span className="text-2xl mt-0.5">{personaSuggest.emoji}</span>
                  <div className="flex-1">
                    <p className="text-sm text-amber-200/90" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
                      下一场，试试「{personaSuggest.name}」？
                    </p>
                    <p className="mt-1 text-xs text-purple-200/60 leading-relaxed">{personaSuggest.reason}</p>
                  </div>
                  <button
                    onClick={() => {
                      const found = personas.find((p) => p.id === personaSuggest.personaId);
                      if (found) {
                        setPersona(found);
                        setPersonaSuggest(null);
                      }
                    }}
                    className="shrink-0 px-4 py-2 rounded-xl border border-amber-400/40 text-amber-200 text-xs hover:bg-amber-900/30 transition-all"
                  >
                    换 TA ↗
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  className="flex-1 px-5 py-3.5 rounded-2xl bg-purple-950/30 backdrop-blur-md border border-purple-500/30 text-purple-50 placeholder-purple-300/40 focus:outline-none focus:border-purple-400/70 transition-all"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                  placeholder="还有困惑？继续追问占卜师…"
                  aria-label="继续追问"
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendFollowup()}
                  maxLength={150}
                />
                <motion.button
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={sendFollowup}
                  className="px-6 py-3.5 rounded-2xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white font-medium shadow-[0_0_24px_rgba(139,92,246,0.4)]"
                >
                  追问
                </motion.button>
              </div>
              <div className="mt-6 flex justify-center gap-3 flex-wrap">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={restart}
                  className="px-8 py-3 rounded-full border border-purple-500/40 text-purple-200 hover:bg-purple-900/40 transition-all tracking-[0.2em]"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                >
                  再问一次
                </motion.button>
                {/* 分享卡：数据源改用 spread（cards 是防剧透空占位，画出来是空白卡）。
                    守卫：至少翻开了 2 张才可分享（数据不全画出来也是残卡） */}
                {(() => {
                  const revealed = spread.filter((c) => c.flipped && c.image);
                  if (revealed.length < 2) return null;
                  return (
                    <div ref={shareCardRef}>
                    <ShareCardButton
                      data={{
                        question,
                        cards: revealed.map((c) => ({ nameZh: c.nameZh, image: c.image, reversed: c.reversed, pos: c.pos })),
                        summary: extractShareSummary(reading),
                        fullReading: reading,
                        personaName: persona?.name,
                        sessionId,
                      }}
                    />
                    </div>
                  );
                })()}
                <a
                  href="/dashboard"
                  className="px-8 py-3 rounded-full border border-sky-500/40 text-sky-200 hover:bg-sky-900/30 transition-all tracking-[0.2em] flex items-center"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                >
                  观测面板 ↗
                </a>
              </div>
            </motion.div>
          )}

          {/* ---------- 过程细节（可折叠：面试演示时展开）----------
              ⚠️ 用 state 而非原生 <details>：折叠时 React 仍渲染全部子树
              （旧 3D 翻牌 + CitedReading 每次 delta 重新分段解析在隐藏状态下空转）。
              现在未展开 = 零渲染。 */}
          {showDetails ? (
            <div className="w-full max-w-2xl mt-6">
              <button
                onClick={() => setShowDetails(false)}
                className="w-full text-xs text-purple-300/70 tracking-wider cursor-pointer select-none hover:text-purple-200 transition-colors text-center"
              >
                ▾ 收起过程细节（子 Agent 流水线 · Trace · RAG 检索 · 审校报告）
              </button>
              <div className="mt-4 flex flex-col items-center gap-4">
                {/* ⚠️ 旧版卡牌区（TarotCardView）已删除：
                    逐张翻牌改造后，cards 事件是匿名槽位（防剧透，image/nameZh 为空），
                    旧组件渲染出三张空图碎卡（用户实测报告的 bug）。
                    翻牌交互已由对话流 SpreadPanel + 顶部 CardSpread 完全取代。 */}
                <SubAgentPipeline events={subagentEvents} />
                <AgentTrace tools={tools} reasoning={reasoning} streaming={streaming && !ask} rounds={rounds} />
                <KnowledgePanel hits={ragHits} />
                {review && <ReviewCard review={review} />}
                {/* 完整正文（旧版卷轴，含可点击引文） */}
                {(reading || error) && (
                  <div className="w-full rounded-3xl bg-gradient-to-b from-[#170d24]/85 to-[#0b0514]/85 backdrop-blur-md border border-purple-500/20 p-6 md:p-9 shadow-2xl max-h-[50vh] overflow-y-auto">
                    {error ? (
                      <p className="text-purple-300/90 text-center py-6">{error}</p>
                    ) : (
                      <CitedReading text={reading} maxCite={ragHits.length} streaming={streaming} />
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowDetails(true)}
              className="mt-6 text-xs text-purple-400/50 tracking-wider cursor-pointer select-none hover:text-purple-300/80 transition-colors text-center"
            >
              ▸ 过程细节（子 Agent 流水线 · Trace · RAG 检索 · 审校报告）
            </button>
          )}
        </motion.div>
      )}

      {/* 页脚 */}
      <footer className="mt-auto pt-12 pb-6 text-center text-purple-400/25 text-xs tracking-[0.25em] z-10">
        MYSTIC TAROT · MULTI-AGENT × HYBRID RAG (BM25+VECTOR) × HITL × REFLEXION × SSE
      </footer>

      {/* 牌面放大预览（点击已翻开的牌 → 只是看，不翻回去） */}
      <CardPreviewModal card={previewCard} onClose={closePreview} />
    </main>
  );
}
