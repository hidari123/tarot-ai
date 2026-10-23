"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import StardustCursor from "@/components/StardustCursor";
import AgentTrace, { type ToolCall } from "@/components/AgentTrace";
import KnowledgePanel, { type RagHitView } from "@/components/KnowledgePanel";

/* ---------------- 类型 ---------------- */

interface AgentCard {
  id: string;
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
}

type Phase = "analyze" | "retrieve" | "draw" | "interpret" | "wait_user" | "done" | "error";

const PHASE_TEXT: Record<Phase, { title: string; icon: string }> = {
  analyze: { title: "凝听问题", icon: "🔮" },
  draw: { title: "命运抽牌", icon: "🃏" },
  retrieve: { title: "翻阅典籍", icon: "📖" },
  interpret: { title: "撰写命运之卷", icon: "✍️" },
  wait_user: { title: "等待你的回应", icon: "💭" },
  done: { title: "解读完成", icon: "✨" },
  error: { title: "波动", icon: "⚠️" },
};

const PHASE_ORDER: Phase[] = ["analyze", "draw", "retrieve", "interpret", "done"];

/* ---------------- 星空背景 ---------------- */

function StarField() {
  const [stars, setStars] = useState<{ x: number; y: number; s: number; d: number; delay: number }[]>([]);
  useEffect(() => {
    setStars(
      Array.from({ length: 90 }, () => ({
        x: Math.random() * 100,
        y: Math.random() * 100,
        s: Math.random() * 2.2 + 0.6,
        d: Math.random() * 4 + 2,
        delay: Math.random() * 4,
      }))
    );
  }, []);
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {stars.map((st, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-purple-200"
          style={{
            left: `${st.x}%`,
            top: `${st.y}%`,
            width: st.s,
            height: st.s,
            animation: `twinkle ${st.d}s ease-in-out ${st.delay}s infinite`,
            boxShadow: "0 0 4px rgba(216,180,254,0.8)",
          }}
        />
      ))}
    </div>
  );
}

function MagicCircle() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
      <div className="magic-ring-1 absolute top-1/2 left-1/2 w-[900px] h-[900px] rounded-full border-2 border-dashed" style={{ borderColor: "rgba(139,92,246,0.14)" }} />
      <div className="magic-ring-2 absolute top-1/2 left-1/2 w-[640px] h-[640px] rounded-full border" style={{ borderColor: "rgba(168,85,247,0.12)" }} />
      <div className="magic-ring-3 absolute top-1/2 left-1/2 w-[420px] h-[420px] rounded-full border-2" style={{ borderColor: "rgba(216,180,254,0.08)" }} />
      <div className="absolute text-7xl text-purple-400/10 rune-breathe select-none">✦</div>
    </div>
  );
}

/* ---------------- 卡牌组件 ---------------- */

function TarotCardView({
  card,
  index,
  flipped,
  onFlip,
}: {
  card: AgentCard;
  index: number;
  flipped: boolean;
  onFlip: (i: number) => void;
}) {
  return (
    <motion.div
      initial={{ y: 60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ delay: index * 0.18, type: "spring", stiffness: 120, damping: 16 }}
      className="perspective-1200"
    >
      <motion.div
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.9, ease: [0.4, 0.1, 0.2, 1] }}
        className="relative w-28 h-44 md:w-40 md:h-64 preserve-3d cursor-pointer group"
        onClick={() => onFlip(index)}
        whileHover={{ y: -6 }}
      >
        {/* 牌背 */}
        <div className="absolute inset-0 backface-hidden rounded-2xl glow-border overflow-hidden bg-[#160b26]">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-16 h-16 md:w-20 md:h-20 rounded-full border-2 border-purple-400/60 flex items-center justify-center rune-breathe">
              <span className="text-3xl md:text-4xl text-purple-300">✦</span>
            </div>
          </div>
          <div className="absolute inset-2 rounded-xl border border-purple-500/25" />
        </div>
        {/* 牌面 */}
        <div className="absolute inset-0 backface-hidden rotate-y-180 rounded-2xl overflow-hidden glow-border bg-[#0d0716]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={card.image}
            alt={card.nameZh}
            className="w-full h-full object-cover"
            style={card.reversed ? { transform: "rotate(180deg)" } : undefined}
            draggable={false}
          />
          {card.reversed && (
            <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-purple-950/85 border border-purple-400/50 text-[10px] md:text-xs text-purple-200 font-medium">
              逆位
            </div>
          )}
        </div>
      </motion.div>

      <div className="mt-3 text-center">
        <div className="text-sm md:text-base text-amber-200/90 font-serif tracking-widest">{card.pos}</div>
        {flipped && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-xs md:text-sm text-purple-300/80 mt-1">
            {card.nameZh}
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}

/* ---------------- Agent 状态条 ---------------- */

function AgentStatusBar({ phase }: { phase: Phase | null }) {
  // 动态顺序：实际发生过的阶段按发生顺序展示
  const order = useMemo(() => {
    if (!phase) return PHASE_ORDER;
    const seen = new Set<Phase>();
    const seq: Phase[] = [];
    for (const p of PHASE_ORDER) {
      seq.push(p);
      seen.add(p);
      if (p === phase) break;
    }
    return seq;
  }, [phase]);

  const curIdx = phase ? PHASE_ORDER.indexOf(phase) : -1;

  return (
    <div className="flex items-center gap-2 flex-wrap justify-center">
      {order.map((p, i) => {
        const active = i === curIdx;
        const past = i < curIdx;
        return (
          <div key={p} className="flex items-center gap-2">
            {i > 0 && <span className={`text-xs ${past ? "text-purple-400/70" : "text-zinc-700"}`}>→</span>}
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs md:text-sm transition-all duration-500 ${
                active
                  ? "bg-purple-900/50 border border-purple-400/60 text-purple-100 shadow-[0_0_16px_rgba(168,85,247,0.35)]"
                  : past
                  ? "bg-purple-950/40 border border-purple-500/25 text-purple-300/80"
                  : "bg-zinc-900/40 border border-zinc-800 text-zinc-600"
              }`}
            >
              <span>{PHASE_TEXT[p].icon}</span>
              <span>{PHASE_TEXT[p].title}</span>
              {active && <span className="animate-pulse">…</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- 主页面 ---------------- */

export default function TarotApp() {
  const [question, setQuestion] = useState("");
  const [stage, setStage] = useState<"input" | "drawing" | "reading">("input");
  const [sessionId, setSessionId] = useState("");
  const [phase, setPhase] = useState<Phase | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [reading, setReading] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [ragHits, setRagHits] = useState<RagHitView[]>([]);
  const [cards, setCards] = useState<AgentCard[]>([]);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  const [ask, setAsk] = useState<{ question: string; options?: string[] } | null>(null);
  const [answerInput, setAnswerInput] = useState("");
  const [followup, setFollowup] = useState("");
  const [followupMode, setFollowupMode] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const readingBoxRef = useRef<HTMLDivElement>(null);
  const askInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = readingBoxRef.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [reading, streaming]);

  useEffect(() => {
    if (ask) askInputRef.current?.focus();
  }, [ask]);

  /* SSE 消费：解析事件流 */
  const consumeStream = useCallback(async (res: Response) => {
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: "解读失败" }));
      throw new Error(err.error || "解读失败");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const evt of events) {
        const line = evt.trim();
        if (!line.startsWith("data:")) continue;
        try {
          const p = JSON.parse(line.slice(5).trim());
          switch (p.type) {
            case "session":
              setSessionId(p.sessionId);
              break;
            case "phase":
              setPhase(p.phase);
              if (p.label) setPhaseLabel(p.label);
              break;
            case "reasoning":
              setReasoning((prev) => (prev + p.reasoning).slice(-4000));
              break;
            case "tool":
              setTools((prev) => [...prev, p.tool]);
              break;
            case "rag_hits":
              setRagHits(p.ragHits ?? []);
              break;
            case "cards":
              setCards(p.cards ?? []);
              setFlipped((p.cards ?? []).map(() => false));
              break;
            case "ask_user":
              setAsk({ question: p.ask.question, options: p.ask.options });
              setPhase("wait_user");
              break;
            case "delta":
              setReading((prev) => prev + p.delta);
              break;
            case "done":
              setPhase("done");
              break;
            case "error":
              setError(p.error);
              break;
          }
        } catch { /* 忽略 */ }
      }
    }
  }, []);

  /* 开始占卜 */
  const startDivination = useCallback(async () => {
    const q = question.trim();
    if (!q) {
      setError("请先在心中默念并写下你的问题 ✦");
      return;
    }
    setError("");
    setReading("");
    setReasoning("");
    setTools([]);
    setRagHits([]);
    setCards([]);
    setFlipped([]);
    setAsk(null);
    setPhase(null);
    setPhaseLabel("");
    setFollowupMode(false);
    setStage("drawing");
    setStreaming(true);

    try {
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      await consumeStream(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解读失败，请重试");
    } finally {
      setStreaming(false);
    }
  }, [question, consumeStream]);

  /* 回答占卜师的问题（HITL） */
  const answerAsk = useCallback(async (answer: string) => {
    if (!answer.trim() || !sessionId) return;
    setAsk(null);
    setAnswerInput("");
    try {
      await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answer: answer.trim() }),
      });
      // SSE 流仍在服务端挂着，事件会继续推来
    } catch {
      setError("回应发送失败，请重试");
    }
  }, [sessionId]);

  /* 追问 */
  const sendFollowup = useCallback(async () => {
    const f = followup.trim();
    if (!f || !sessionId) return;
    setFollowup("");
    setReading((prev) => prev + `\n\n【追问】${f}\n`);
    setStreaming(true);
    setError("");
    try {
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, followup: f }),
      });
      await consumeStream(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "追问失败");
    } finally {
      setStreaming(false);
    }
  }, [followup, sessionId, consumeStream]);

  /** 翻牌（不可翻回） */
  const handleFlip = useCallback((i: number) => {
    setFlipped((prev) => {
      if (prev[i]) return prev;
      const next = [...prev];
      next[i] = true;
      return next;
    });
  }, []);

  const restart = useCallback(() => {
    setStage("input");
    setSessionId("");
    setQuestion("");
    setCards([]);
    setFlipped([]);
    setReading("");
    setReasoning("");
    setTools([]);
    setRagHits([]);
    setAsk(null);
    setPhase(null);
    setPhaseLabel("");
    setError("");
    setStreaming(false);
    setFollowupMode(false);
  }, []);

  const allFlipped = flipped.length > 0 && flipped.every(Boolean);
  const done = phase === "done" && !streaming;

  return (
    <main className="relative min-h-screen overflow-hidden flex flex-col items-center pt-14 md:pt-20 px-4">
      <StardustCursor />
      <StarField />
      <MagicCircle />

      {/* 标题 */}
      <motion.h1
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="text-shimmer text-4xl md:text-6xl tracking-[0.3em] z-10 select-none"
        style={{ fontFamily: "Cinzel, Georgia, serif" }}
      >
        MYSTIC TAROT
      </motion.h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4, duration: 0.8 }}
        className="mt-3 text-lg md:text-xl text-purple-300/60 z-10 tracking-[0.2em]"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        倾听星辰的低语 · 窥探命运的轨迹
      </motion.p>

      <div className="h-10" />

      {/* ---------- 输入阶段 ---------- */}
      {stage === "input" && (
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7 }}
          className="w-full max-w-xl z-10"
        >
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              className="flex-1 px-5 py-4 text-lg rounded-2xl bg-purple-950/30 backdrop-blur-md border border-purple-500/30 text-purple-50 placeholder-purple-300/40 focus:outline-none focus:border-purple-400/70 focus:shadow-[0_0_24px_rgba(168,85,247,0.25)] transition-all"
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
              placeholder="在此写下你的困惑…"
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
                setError("");
              }}
              onKeyDown={(e) => e.key === "Enter" && startDivination()}
              maxLength={100}
            />
            <motion.button
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.96 }}
              onClick={startDivination}
              className="px-8 py-4 rounded-2xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-lg font-medium shadow-[0_0_28px_rgba(139,92,246,0.45)] hover:shadow-[0_0_40px_rgba(139,92,246,0.65)] transition-shadow"
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              开始占卜
            </motion.button>
          </div>
          {error && <p className="mt-3 text-purple-400/90 text-sm text-center sm:text-left">{error}</p>}
          <p className="mt-6 text-center text-purple-300/40 text-sm tracking-wide">
            AI 占卜师会与你对话澄清困惑 · 亲手见证命运之牌 · 解读引用塔罗典籍
          </p>
        </motion.div>
      )}

      {/* ---------- 占卜中阶段 ---------- */}
      {stage !== "input" && (
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="w-full max-w-4xl z-10 flex flex-col items-center"
        >
          {/* 抽牌等待提示 */}
          {cards.length === 0 && !ask && (
            <div className="flex flex-col items-center gap-5 py-10">
              <motion.div
                animate={{ rotate: [0, -8, 8, -6, 6, 0], scale: [1, 1.05, 1, 1.08, 1, 1] }}
                transition={{ duration: 1.4, repeat: 2 }}
                className="text-7xl"
              >
                🔮
              </motion.div>
              <p className="text-purple-300/80 text-lg animate-pulse tracking-[0.3em]" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
                {streaming ? "星辰流转 · 占卜师工作中" : "等待中"}
              </p>
            </div>
          )}

          {/* 卡牌区 */}
          {cards.length > 0 && (
            <div className="flex gap-3 md:gap-8 justify-center flex-wrap">
              {cards.map((card, i) => (
                <TarotCardView key={`${card.id}-${i}`} card={card} index={i} flipped={flipped[i]} onFlip={handleFlip} />
              ))}
            </div>
          )}

          {/* HITL 问答区 */}
          <AnimatePresence>
            {ask && (
              <motion.div
                initial={{ opacity: 0, y: 20, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.97 }}
                className="w-full max-w-xl mt-8 rounded-3xl border border-emerald-500/30 bg-emerald-950/15 backdrop-blur-md p-6 md:p-7 shadow-[0_0_40px_rgba(16,185,129,0.12)]"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xl">💭</span>
                  <span className="text-emerald-200/90 text-sm tracking-wider">占卜师想要了解你</span>
                </div>
                <p className="text-lg md:text-xl text-purple-50/95 leading-relaxed mb-4" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
                  {ask.question}
                </p>
                {ask.options && ask.options.length > 0 && (
                  <div className="flex flex-col gap-2 mb-3">
                    {ask.options.map((opt) => (
                      <motion.button
                        key={opt}
                        whileHover={{ scale: 1.02, x: 4 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => answerAsk(opt)}
                        className="text-left px-5 py-3 rounded-xl border border-emerald-500/30 bg-emerald-900/20 text-emerald-100/90 hover:bg-emerald-800/30 hover:border-emerald-400/50 transition-all"
                      >
                        {opt}
                      </motion.button>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    ref={askInputRef}
                    className="flex-1 px-4 py-3 rounded-xl bg-purple-950/30 border border-purple-500/30 text-purple-50 placeholder-purple-300/40 focus:outline-none focus:border-emerald-400/60 transition-all"
                    placeholder="或自由输入你的回答…"
                    value={answerInput}
                    onChange={(e) => setAnswerInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && answerAsk(answerInput)}
                    maxLength={200}
                  />
                  <button
                    onClick={() => answerAsk(answerInput)}
                    className="px-5 py-3 rounded-xl bg-gradient-to-r from-emerald-700 to-teal-700 text-white font-medium hover:shadow-[0_0_24px_rgba(16,185,129,0.4)] transition-shadow"
                  >
                    回应
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Agent 状态条 */}
          {(phase || streaming) && cards.length > 0 && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-8">
              <AgentStatusBar phase={phase} />
              {phaseLabel && <p className="mt-2 text-center text-xs text-purple-400/60 tracking-wide">{phaseLabel}</p>}
            </motion.div>
          )}

          {/* Agent Trace 面板 */}
          <AgentTrace tools={tools} reasoning={reasoning} streaming={streaming && !ask} />

          {/* RAG 知识面板 */}
          <KnowledgePanel hits={ragHits} />

          {/* 解读文本区 */}
          {(reading || error) && (
            <div
              ref={readingBoxRef}
              className="mt-6 w-full max-w-2xl rounded-3xl bg-gradient-to-b from-[#170d24]/85 to-[#0b0514]/85 backdrop-blur-md border border-purple-500/20 p-6 md:p-9 shadow-2xl max-h-[50vh] overflow-y-auto"
            >
              {error ? (
                <p className="text-purple-300/90 text-center py-6">{error}</p>
              ) : (
                <pre
                  className="whitespace-pre-wrap text-purple-50/90 text-base md:text-lg leading-loose tracking-wide"
                  style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                >
                  {reading}
                  {streaming && <span className="typing-cursor text-purple-300">▍</span>}
                </pre>
              )}
            </div>
          )}

          {/* 追问输入 */}
          {done && sessionId && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-2xl mt-5"
            >
              <div className="flex gap-2">
                <input
                  className="flex-1 px-5 py-3.5 rounded-2xl bg-purple-950/30 backdrop-blur-md border border-purple-500/30 text-purple-50 placeholder-purple-300/40 focus:outline-none focus:border-purple-400/70 transition-all"
                  style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                  placeholder="还有困惑？继续追问占卜师…"
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
              <div className="mt-6 flex justify-center">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={restart}
                  className="px-8 py-3 rounded-full border border-purple-500/40 text-purple-200 hover:bg-purple-900/40 transition-all tracking-[0.2em]"
                  style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                >
                  再问一次
                </motion.button>
              </div>
            </motion.div>
          )}
        </motion.div>
      )}

      {/* 页脚 */}
      <footer className="mt-auto pt-14 pb-6 text-center text-purple-400/25 text-xs tracking-[0.25em] z-10">
        MYSTIC TAROT · LLM AGENT × RAG (BM25) × HITL × SSE STREAM
      </footer>
    </main>
  );
}
