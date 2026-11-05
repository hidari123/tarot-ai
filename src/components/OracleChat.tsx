"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import Icon from "@/components/icons";
import KnowledgePanel, { type RagHitView } from "@/components/KnowledgePanel";
import CelestialBackdrop from "@/components/CelestialBackdrop";

/**
 * 神谕（Oracle）—— 免抽牌的对话式塔罗向导（2026-11-04 D 方向）
 *
 * ⚠️⚠️ 为什么**不复用**首页的对话流组件：
 *   首页的 DialogueFlow 深度耦合了牌阵状态（FlowSpreadCard / flip / preview），
 *   神谕没有牌阵 → 强行复用会带进一堆永远为空的分支与守卫。
 *   → 神谕有自己的**轻量对话流**（气泡 + 追问输入 + 引用面板）。
 *   ⚠️ 但**协议层完全一致**（同一个 /api/interpret + SSE 事件格式）——
 *   这样后端零改动成本，且未来两边可以合并。
 *
 * ⚠️ 竞品对标（Tarot Run 的 Oracle）：
 *   「無論是剛抽到的牌、看不懂的牌陣，還是想理清的處境，都可以直接提問」
 *   「可以追問 —— 一次解讀往往不夠。神諭會記住上下文」
 */

interface OracleMessage {
  id: string;
  role: "user" | "oracle";
  text: string;
}

/** 与首页一致的事件协议（只取神谕用得到的部分） */
type OracleEvent =
  | { type: "delta"; delta?: string }
  | { type: "done" }
  | { type: "error"; error?: string }
  | { type: "phase"; label?: string }
  | { type: "session"; sessionId?: string }
  // ⚠️ 字段名是 ragHits（不是 hits）—— 与首页的 KnowledgePanel 数据源一致
  | { type: "rag_hits"; ragHits?: RagHitView[] }
  | { type: "ask_user"; ask?: { question?: string; options?: string[]; allowFree?: boolean } };

export default function OracleChat() {
  const [messages, setMessages] = useState<OracleMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [error, setError] = useState("");
  const [hits, setHits] = useState<RagHitView[]>([]);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<{ id: string; question: string; options?: string[] } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bufRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const msgIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  /** 流式文本的节流 flush（rAF 批量写 React state，避免每 36 字一次重渲染） */
  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const text = bufRef.current;
    if (!text) return;
    bufRef.current = "";
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "oracle") return prev;
      return [...prev.slice(0, -1), { ...last, text: last.text + text }];
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(flush, 60);
  }, [flush]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  /**
   * 事件处理
   *
   * ⚠️ 必须**定义在 send 之前**（不是之后）：
   *   send 的 useCallback 依赖它，若定义在后面会拿到 undefined（TDZ）。
   *   → 顺序调整：handleEvent → send。
   */
  const handleEvent = useCallback(
    (p: OracleEvent, askId?: string) => {
      switch (p.type) {
        case "delta": {
          const d = p.delta ?? "";
          if (!d) return;
          bufRef.current += d;
          scheduleFlush();
          return;
        }
        case "session":
          if (p.sessionId) setSessionId(p.sessionId);
          return;
        case "phase":
          setPhaseLabel(p.label ?? "");
          return;
        case "rag_hits":
          if (p.ragHits && p.ragHits.length) {
            setHits(p.ragHits);
            setShowKnowledge(true);
          }
          return;
        case "ask_user": {
          const q = p.ask?.question ?? "";
          if (!q) return;
          setPendingAsk({ id: askId ?? `ask${msgIdRef.current++}`, question: q, options: p.ask?.options });
          return;
        }        case "error":
          setError(p.error ?? "出错了");
          return;
        case "done":
          // ⚠️ done 时必须 flush 缓冲并结束 busy ——
          //   否则最后一段文字（还在缓冲区里）永远不显示，且输入框一直被禁用。
          flush();
          setBusy(false);
          return;
      }
    },
    [flush, scheduleFlush]
  );

  /**
   * 发消息（首问 or 追问）
   *
   * ⚠️ 首问 vs 追问的区别（后端靠 sessionId 是否存在来判断）：
   *   有 sessionId → body.followup（走追问路径，保留上下文）
   *   无 sessionId → body.question + kind:"oracle"（新建神谕会话）
   */
  const send = useCallback(
    async (text: string, askId?: string) => {
      const q = text.trim();
      if (!q || busy) return;

      setError("");
      setBusy(true);
      setPendingAsk(null);

      // 用户气泡
      setMessages((prev) => [
        ...prev,
        { id: `u${msgIdRef.current++}`, role: "user", text: q },
        // 占位的 oracle 气泡（流式内容会追加进来）
        { id: `o${msgIdRef.current++}`, role: "oracle", text: "" },
      ]);
      setInput("");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const body: Record<string, unknown> = sessionId
          ? { sessionId, followup: q }
          : { question: q, kind: "oracle" };

        const res = await fetch("/api/interpret", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const t = await res.text().catch(() => "");
          setError(t.slice(0, 200) || `请求失败（${res.status}）`);
          // 移除空的 oracle 气泡
          setMessages((prev) => prev.filter((m) => m.text !== "" || m.role === "user"));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE：事件以空行分隔
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = raw
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let p: OracleEvent;
            try {
              p = JSON.parse(payload);
            } catch {
              continue;
            }
            handleEvent(p, askId);
          }
        }
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setError("连接中断，请重试");
        }
        setMessages((prev) => prev.filter((m) => m.text !== "" || m.role === "user"));
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, sessionId, handleEvent]
  );

  /**
   * 回答神谕的提问（ask_user）
   *
   * ⚠️⚠️ 必须走 **api/answer 端点**（而不是重新发一次 interpret）：
   *   ask_user 之后，后端正**挂起等待**这个回答（pendingAsk）。
   *   正确流程是"回填答案 → 后端继续推进 → 同一个 SSE 流继续输出"。
   *   若重新发 interpret，会**新建一个会话** → 上下文丢失、
   *   原会话永远卡在 busy → 追问全部 409。
   */
  const answerAsk = useCallback(
    async (text: string) => {
      const a = text.trim();
      if (!a || !sessionId) return;
      setPendingAsk(null);
      setBusy(true);
      setError("");
      try {
        const r = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: a }),
        });
        if (!r.ok) {
          setError("回答提交失败，请重试");
          setBusy(false);
        }
        // ⚠️ 成功后**不**结束 busy —— 后端会继续推事件，
        //    由 SSE 的 done 事件统一收尾（见下方 handleEvent 的 done 分支）
      } catch {
        setError("回答提交失败，请重试");
        setBusy(false);
      }
    },
    [sessionId]
  );
  /** 快捷提问（开场白上的示例） */
  const samples = [
    "宝剑三和星星这两张牌放在一起是什么意思？",
    "我最近很焦虑，该不该换个方向？",
    "我想问工作上的事，用哪种牌阵比较好？",
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col relative">
      {/* ⚠️ 2026-11-05 视觉重设计：统一的深空背景（神谕偏冷蓝 —— 冷光更有"清明的凝视"感） */}
      <CelestialBackdrop tint="rgba(99, 102, 241, 0.16)" />
      {/* 顶栏 */}
      <header className="shrink-0 border-b border-white/6 bg-[#0d0a18]/70 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-5 py-3 flex items-center justify-between">
          <Link href="/" className="text-sm text-purple-300/50 hover:text-purple-200 transition-colors">
            ← 回到占卜
          </Link>
          <div className="flex items-center gap-2">
            <Icon name="crystal" size={15} className="text-purple-300/70" />
            <span className="text-sm tracking-[0.2em] text-purple-100/80">神 谕</span>
          </div>
          <button
            onClick={() => setShowKnowledge((v) => !v)}
            className="text-sm text-purple-300/50 hover:text-purple-200 transition-colors"
          >
            {showKnowledge ? "收起典籍" : "查看典籍"}
          </button>
        </div>
      </header>

      {/* 对话区 */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ scrollBehavior: "smooth" }}
      >
        <div className="relative z-10 max-w-3xl mx-auto px-5 py-6 space-y-5">
          {/* 开场白 */}
          {messages.length === 0 && (
            <div className="pt-8">
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="text-center mb-8"
              >
                <Icon name="crystal" size={30} className="text-purple-300/60 mx-auto mb-4" />
                <h1 className="text-xl tracking-[0.15em] text-purple-50 mb-3">问神谕</h1>
                <p className="text-sm text-purple-200/45 leading-relaxed max-w-md mx-auto">
                  不必抽牌，也可以问。
                  <br />
                  牌的含义、你的处境、该用哪种方式 —— 都可以聊。
                </p>
              </motion.div>

              <div className="space-y-2">
                {samples.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="w-full text-left rounded-xl border border-white/8 bg-purple-950/15 px-4 py-3 text-[13px] text-purple-100/70 hover:border-purple-400/30 hover:bg-purple-900/20 transition-all"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 消息 */}
          <AnimatePresence initial={false}>
            {messages.map((m) => {
              if (m.role === "user") {
                return (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex justify-end"
                  >
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-purple-700/40 border border-purple-400/20 px-4 py-2.5 text-[14px] leading-relaxed text-purple-50">
                      {m.text}
                    </div>
                  </motion.div>
                );
              }
              return (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex justify-start"
                >
                  <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-purple-950/30 border border-white/8 px-4 py-3 text-[14px] leading-[1.85] text-purple-100/85 whitespace-pre-line">
                    {m.text || (busy ? <ThinkingDots /> : null)}
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          {/* 思考中 */}
          {busy && messages.length > 0 && messages[messages.length - 1]?.role === "user" && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="rounded-2xl rounded-bl-md bg-purple-950/30 border border-white/8 px-4 py-3">
                <ThinkingDots />
              </div>
            </motion.div>
          )}

          {phaseLabel && busy && (
            <p className="text-[11px] text-purple-300/35 pl-1">{phaseLabel}</p>
          )}

          {error && (
            <div className="rounded-xl border border-rose-400/25 bg-rose-900/15 px-4 py-3 text-[13px] text-rose-200/80">
              {error}
            </div>
          )}

          {/* 追问面板 */}
          {pendingAsk && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-2xl border border-purple-400/25 bg-purple-950/30 p-4"
            >
              <p className="text-[14px] text-purple-100/85 mb-3">{pendingAsk.question}</p>
              {pendingAsk.options && pendingAsk.options.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {pendingAsk.options.map((o) => (
                    <button
                      key={o}
                      onClick={() => answerAsk(o)}
                      className="px-3 py-1.5 rounded-full border border-purple-400/30 text-[12px] text-purple-200/80 hover:bg-purple-900/40 transition-colors"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
              <input
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.shiftKey) {
                    e.preventDefault();
                    answerAsk(input);
                    setInput("");
                  }
                }}
                placeholder="说说你的想法…"
                className="w-full bg-transparent border-b border-purple-400/25 pb-2 text-[14px] text-purple-50 placeholder:text-purple-300/30 focus:outline-none focus:border-purple-400/60"
              />
            </motion.div>
          )}
        </div>

        {/* 典籍面板 */}
        {showKnowledge && hits.length > 0 && (
          <div className="relative z-10 max-w-3xl mx-auto px-5 pb-6">
            <KnowledgePanel hits={hits} />
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="relative z-10 shrink-0 border-t border-white/6 bg-[#0d0a18]/80 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-5 py-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              disabled={busy}
              placeholder={busy ? "神谕正在回应…" : "问点什么…（Enter 发送）"}
              className="flex-1 resize-none bg-purple-950/25 border border-purple-400/18 rounded-xl px-4 py-2.5 text-[14px] text-purple-50 placeholder:text-purple-300/30 focus:outline-none focus:border-purple-400/45 disabled:opacity-50 max-h-32"
            />
            <button
              onClick={() => send(input)}
              disabled={busy || !input.trim()}
              className="shrink-0 px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-[13px] tracking-wider disabled:opacity-35 hover:shadow-[0_0_20px_rgba(139,92,246,0.35)] transition-shadow"
            >
              问
            </button>
          </div>
          <p className="mt-2 text-[10px] text-purple-300/22 text-center">
            神谕给的是视角与方向，不是预言。
          </p>
        </div>
      </div>
    </div>
  );
}

/** 思考中的三点动画 */
function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-purple-300/60"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
        />
      ))}
    </span>
  );
}
