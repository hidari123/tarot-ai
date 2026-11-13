"use client";

import { useCallback } from "react";

import type { FlowEntry } from "./types";

/**
 * useFollowup —— 追问 / 插话 / 语音输入（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么这三件事在一起：
 *   · 它们都是"用户在仪式进行中追加输入"的通道
 *   · 共享同一套前置检查（streaming 连点防护、sessionId 有效性）
 *   · 共享同一套失效处理（410 → 静默收起追问入口）
 *   → 三条通道的语义一致 → 放一起好维护 ✅
 */

export interface FollowupParams {
  /** 当前会话 id */
  sessionId: string;
  /** sessionId 的 ref 镜像 */
  sessionIdRef: React.RefObject<string>;
  /** 是否正在流式输出（连点防护） */
  streaming: boolean;
  /** 追问输入框的内容 */
  followup: string;
  /** 清空追问输入框 */
  setFollowup: (v: string | ((prev: string) => string)) => void;
  /** 插话输入框的内容 */
  interject: string;
  /** 清空插话输入框 */
  setInterject: (v: string | ((prev: string) => string)) => void;
  /** 追加一条对话流条目 */
  pushEntry: (e: Omit<FlowEntry, "id"> & { id?: string }) => string;
  /** 追加正文 */
  setReading: (v: string | ((prev: string) => string)) => void;
  /** 标记流式开始 */
  setStreaming: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** 记录流开始时间 */
  setStreamStart: (v: number | ((prev: number) => number)) => void;
  /** 错误横幅 */
  setError: (v: string | ((prev: string) => string)) => void;
  /** 清空会话 id */
  setSessionId: (v: string | ((prev: string) => string)) => void;
  /** 关闭追问入口 */
  setCanFollowup: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** 设置问题输入框（语音识别结果） */
  setQuestion: (v: string | ((prev: string) => string)) => void;
  /** 语音识别中 */
  setListening: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** delta 分流目标（追问时清空 → 正文开新气泡） */
  deltaTargetRef: React.RefObject<{
    type: "card" | "scroll" | "teller";
    entryId?: string;
  } | null>;
  /** 发起一次可取消的请求 */
  fetchStream: (
    url: string,
    body: unknown,
    init?: { headers?: Record<string, string> }
  ) => Promise<Response>;
  /** 消费 SSE 流 */
  consumeStream: (res: Response) => Promise<void>;
}

export interface FollowupApi {
  /** 方案 C：用户插话（补充/修正信息） */
  sendInterjection: () => Promise<void>;
  /** 追问 */
  sendFollowup: () => Promise<void>;
  /** 语音输入 */
  startVoice: () => void;
}

export function useFollowup(params: FollowupParams): FollowupApi {
  const {
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
  } = params;

  /* 方案 C：用户插话（补充/修正信息） */
  const sendInterjection = useCallback(async () => {
    const text = interject.trim();
    if (!text || !sessionId) return;
    setInterject("");
    // 插话立刻显示在对话流里（用户气泡）
    pushEntry({ kind: "user", text });
    // 插话作为独立通道：追加进会话历史，不唤醒当前等待
    setReading((prev) => prev + `\n\n【补充】${text}\n`);
    try {
      await fetch("/api/interject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text }),
      });
    } catch {
      setError("插话发送失败");
    }
  }, [interject, sessionId, pushEntry, setError, setInterject, setReading]);

  /* 追问 */
  const sendFollowup = useCallback(async () => {
    // ⚠️ 连点防护：流式进行中再追问会并发两个 SSE 流
    if (streaming) return;
    const f = followup.trim();
    if (!f || !sessionId) return;
    setFollowup("");
    // 追问显示为用户气泡；正文以新气泡流式呈现（清掉旧的 delta 目标）
    pushEntry({ kind: "user", text: `【追问】${f}` });
    deltaTargetRef.current = null;
    setReading((prev) => prev + `\n\n【追问】${f}\n`);
    setStreaming(true);
    setStreamStart(Date.now());
    setError("");
    try {
      // ⚠️ 用 fetchStream（内部处理 AbortController + 取消上一个流）
      const res = await fetchStream("/api/interpret", { sessionId, followup: f });
      if (!res.ok && res.status === 410) {
        /**
         * ⚠️ 会话不可用（2026-11-04 改文案）
         *
         * ⚠️ 之前一律写"这场占卜已过期（超过 30 分钟），请重新开始"——
         *   但 410 的真实原因有两个，**文案必须区分**，否则用户会以为内容丢了：
         *     ① 会话已完成（内存里被 cleanExpired 逐出，但 DB 里有完整解读）
         *     ② 会话真的超时/服务重启
         *   两种情况下正文都还在 DB 里，用户刷新仍能看到。
         */
        try {
          localStorage.removeItem("tarot:sessionId");
        } catch {
          /* ignore */
        }
        setSessionId("");
        sessionIdRef.current = "";
        setCanFollowup(false);
        // ⚠️ 不弹错误横幅 —— 弹了会让用户以为"解读没了"。
        //    改为静默收起追问入口（"可追问"面板依赖 sessionId → 会自动消失）。
        setError("");
        return;
      }
      await consumeStream(res);
    } catch (e) {
      // ⚠️ P0-③：主动取消不是错误
      if (e instanceof DOMException && e.name === "AbortError") {
        setStreaming(false);
        return;
      }
      setError(e instanceof Error ? e.message : "追问失败");
    } finally {
      setStreaming(false);
    }
  }, [
    followup,
    sessionId,
    sessionIdRef,
    consumeStream,
    pushEntry,
    streaming,
    setCanFollowup,
    setError,
    setFollowup,
    setReading,
    setSessionId,
    setStreamStart,
    setStreaming,
    deltaTargetRef,
    fetchStream,
  ]);

  /* 语音输入 */
  const startVoice = useCallback(() => {
    type SpeechRecognitionLike = {
      lang: string;
      interimResults: boolean;
      onresult: ((e: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    const w = window as unknown as Record<
      string,
      (new () => SpeechRecognitionLike) | undefined
    >;
    const SRC = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SRC) {
      setError("当前浏览器不支持语音输入");
      return;
    }
    const rec = new SRC();
    rec.lang = "zh-CN";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join("");
      setQuestion((prev) => (prev ? prev + text : text));
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
    setListening(true);
  }, [setError, setListening, setQuestion]);

  return { sendInterjection, sendFollowup, startVoice };
}
