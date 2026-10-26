"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import StardustCursor from "@/components/StardustCursor";
import AgentTrace, { type ToolCall, type RoundInfo } from "@/components/AgentTrace";
import KnowledgePanel, { type RagHitView } from "@/components/KnowledgePanel";
import CitedReading from "@/components/CitedReading";
import ShareCardButton from "@/components/ShareCard";
import CardFan, { type FanCard } from "@/components/CardFan";
import ReviewCard, { type ReviewData } from "@/components/ReviewCard";
import SubAgentPipeline, { type SubAgentEvent } from "@/components/SubAgentPipeline";

/* ---------------- 类型 ---------------- */

interface AgentCard {
  id: string;
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
}

interface PersonaView {
  id: string;
  name: string;
  emoji: string;
  desc: string;
}

type Phase = "analyze" | "retrieve" | "draw" | "interpret" | "wait_user" | "review" | "done" | "error";

const PHASE_TEXT: Record<Phase, { title: string; icon: string }> = {
  analyze: { title: "凝听问题", icon: "🔮" },
  draw: { title: "命运之牌", icon: "🃏" },
  retrieve: { title: "翻阅典籍", icon: "📖" },
  interpret: { title: "撰写命运之卷", icon: "✍️" },
  wait_user: { title: "等待你的回应", icon: "💭" },
  review: { title: "审校检视", icon: "🧐" },
  done: { title: "解读完成", icon: "✨" },
  error: { title: "波动", icon: "⚠️" },
};

const PHASE_ORDER: Phase[] = ["analyze", "draw", "retrieve", "interpret", "review", "done"];

/* ---------------- 星空 & 魔法阵 ---------------- */

function StarField() {
  // 星点在挂载后生成（客户端专属）：Math.random 不能进预渲染
  const [stars, setStars] = useState<Array<{ x: number; y: number; s: number; d: number; delay: number }>>([]);
  useEffect(() => {
    // Next.js 16 预渲染禁用 Math.random（会被烘进静态壳），必须 defer 到客户端 effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  if (stars.length === 0) return null;
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

function TarotCardView({ card, index, flipped, onFlip }: { card: AgentCard; index: number; flipped: boolean; onFlip: (i: number) => void }) {
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
        <div className="absolute inset-0 backface-hidden rounded-2xl glow-border overflow-hidden bg-[#160b26]">
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-16 h-16 md:w-20 md:h-20 rounded-full border-2 border-purple-400/60 flex items-center justify-center rune-breathe">
              <span className="text-3xl md:text-4xl text-purple-300">✦</span>
            </div>
          </div>
          <div className="absolute inset-2 rounded-xl border border-purple-500/25" />
        </div>
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
  const order = useMemo(() => {
    if (!phase) return PHASE_ORDER;
    const idx = PHASE_ORDER.indexOf(phase);
    return PHASE_ORDER.slice(0, Math.max(idx + 1, 1));
  }, [phase]);
  const curIdx = phase ? PHASE_ORDER.indexOf(phase) : -1;

  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-center">
      {order.map((p, i) => {
        const active = i === curIdx;
        const past = i < curIdx;
        return (
          <div key={p} className="flex items-center gap-1.5">
            {i > 0 && <span className={`text-[10px] ${past ? "text-purple-400/70" : "text-zinc-700"}`}>→</span>}
            <div
              className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] md:text-xs transition-all duration-500 ${
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

/** 等待反馈：显示已等待时长，超过 10 秒提示模型较慢 */
function WaitingHint({ since }: { since: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - since) / 1000)), 500);
    return () => clearInterval(t);
  }, [since]);

  if (!since || elapsed < 3) return null;
  const slow = elapsed >= 10;

  return (
    <motion.p
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`mt-1.5 text-center text-xs tracking-wide ${slow ? "text-amber-300/80" : "text-purple-400/50"}`}
    >
      {slow
        ? `模型仍在思考… 已等待 ${elapsed}s（模型较慢，可查看下方时间轴定位瓶颈）`
        : `思考中… ${elapsed}s`}
    </motion.p>
  );
}

/* ---------------- 主页面 ---------------- */

export default function TarotApp() {
  const [question, setQuestion] = useState("");
  const [persona, setPersona] = useState<PersonaView | null>(null);
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [stage, setStage] = useState<"input" | "drawing" | "reading">("input");
  const [sessionId, setSessionId] = useState("");
  const [phase, setPhase] = useState<Phase | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [reading, setReading] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [rounds, setRounds] = useState<RoundInfo[]>([]);
  const [ragHits, setRagHits] = useState<RagHitView[]>([]);
  const [cards, setCards] = useState<AgentCard[]>([]);
  const [flipped, setFlipped] = useState<boolean[]>([]);
  const [ask, setAsk] = useState<{ question: string; options?: string[]; cardSelection?: boolean; crossroads?: boolean } | null>(null);
  const [fanCards, setFanCards] = useState<FanCard[]>([]);
  const [fanCount, setFanCount] = useState(3);
  const [answerInput, setAnswerInput] = useState("");
  const [followup, setFollowup] = useState("");
  const [subagentEvents, setSubagentEvents] = useState<SubAgentEvent[]>([]);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [streamStart, setStreamStart] = useState(0);
  const readingBoxRef = useRef<HTMLDivElement>(null);
  const askInputRef = useRef<HTMLInputElement>(null);

  /* 拉取人格列表 */
  useEffect(() => {
    fetch("/api/personas")
      .then((r) => r.json())
      .then((d) => setPersonas(d.personas ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const el = readingBoxRef.current;
    if (el && streaming) el.scrollTop = el.scrollHeight;
  }, [reading, streaming]);

  useEffect(() => {
    if (ask && !ask.cardSelection) askInputRef.current?.focus();
  }, [ask]);

  /* SSE 消费 */
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
              // 冗余通道：rag_search 的 tool 事件也内嵌 ragHits，
              // 万一独立 rag_hits 事件丢失，前端仍能渲染知识面板
              if (p.tool?.name === "rag_search" && Array.isArray(p.ragHits)) {
                setRagHits(p.ragHits);
              }
              break;
            case "rag_hits":
              setRagHits(p.ragHits ?? []);
              break;
            case "cards":
              setCards(p.cards ?? []);
              setFlipped((p.cards ?? []).map(() => false));
              break;
            case "ask_user":
              setAsk({ question: p.ask.question, options: p.ask.options, cardSelection: p.cardSelection, crossroads: p.crossroads });
              if (p.cardSelection) {
                // 候选扇面由 ask_user 事件直接携带（7 张随机牌）
                if (Array.isArray(p.fanCards) && p.fanCards.length > 0) setFanCards(p.fanCards);
                setFanCount(p.fanCount ?? 3);
              }
              setPhase("wait_user");
              break;
            case "subagent":
              setSubagentEvents((prev) => [...prev, p.subagent]);
              break;
            case "round":
              setRounds((prev) => [...prev, p.round]);
              break;
            case "review":
              setReview(p.review);
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
    setRounds([]);
    setRagHits([]);
    setCards([]);
    setFlipped([]);
    setAsk(null);
    setFanCards([]);
    setSubagentEvents([]);
    setReview(null);
    setPhase(null);
    setPhaseLabel("");
    setStage("drawing");
    setStreaming(true);
    setStreamStart(Date.now());

    try {
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, persona: persona?.id }),
      });
      await consumeStream(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解读失败，请重试");
    } finally {
      setStreaming(false);
    }
  }, [question, persona, consumeStream]);

  /* HITL 应答 */
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
    } catch {
      setError("回应发送失败，请重试");
    }
  }, [sessionId]);

  /* 选牌确认 */
  const confirmFanSelection = useCallback((payload: string) => {
    answerAsk(payload);
  }, [answerAsk]);

  /* 追问 */
  const sendFollowup = useCallback(async () => {
    const f = followup.trim();
    if (!f || !sessionId) return;
    setFollowup("");
    setReading((prev) => prev + `\n\n【追问】${f}\n`);
    setStreaming(true);
    setStreamStart(Date.now());
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

  /* 语音输入 */
  const startVoice = useCallback(() => {
    type SpeechRecognitionLike = {
      lang: string;
      interimResults: boolean;
      onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: (() => void) | null;
      onend: (() => void) | null;
      start: () => void;
    };
    const w = window as unknown as Record<string, (new () => SpeechRecognitionLike) | undefined>;
    const SRC = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SRC) {
      setError("当前浏览器不支持语音输入");
      return;
    }
    const rec = new SRC();
    rec.lang = "zh-CN";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results).map((r) => r[0].transcript).join("");
      setQuestion((prev) => (prev ? prev + text : text));
      setListening(false);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    rec.start();
    setListening(true);
  }, []);

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
    setRounds([]);
    setRagHits([]);
    setAsk(null);
    setFanCards([]);
    setSubagentEvents([]);
    setReview(null);
    setPhase(null);
    setPhaseLabel("");
    setError("");
    setStreaming(false);
  }, []);

  const done = phase === "done" && !streaming;

  return (
    <main className="relative min-h-screen overflow-hidden flex flex-col items-center pt-12 md:pt-16 px-4">
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

      <div className="h-8" />

      {/* ---------- 输入阶段 ---------- */}
      {stage === "input" && (
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7 }}
          className="w-full max-w-xl z-10"
        >
          {/* 人格选择 */}
          <div className="mb-5">
            <p className="text-xs text-purple-300/50 mb-2 tracking-wider">选择你的占卜师</p>
            <div className="grid grid-cols-3 gap-2">
              {personas.map((p) => (
                <motion.button
                  key={p.id}
                  whileHover={{ scale: 1.03, y: -2 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setPersona(p)}
                  className={`rounded-2xl border px-3 py-3 text-left transition-all ${
                    persona?.id === p.id
                      ? "border-purple-400/70 bg-purple-900/40 shadow-[0_0_20px_rgba(168,85,247,0.3)]"
                      : "border-purple-500/20 bg-purple-950/20 hover:border-purple-400/40"
                  }`}
                >
                  <div className="text-xl mb-1">{p.emoji}</div>
                  <div className="text-sm text-purple-100/90" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>{p.name}</div>
                  <div className="text-[10px] text-purple-300/50 mt-0.5 leading-tight">{p.desc}</div>
                </motion.button>
              ))}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <input
                className="w-full px-5 py-4 pr-12 text-lg rounded-2xl bg-purple-950/30 backdrop-blur-md border border-purple-500/30 text-purple-50 placeholder-purple-300/40 focus:outline-none focus:border-purple-400/70 focus:shadow-[0_0_24px_rgba(168,85,247,0.25)] transition-all"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                placeholder="在此写下你的困惑…"
                value={question}
                onChange={(e) => { setQuestion(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && startDivination()}
                maxLength={100}
              />
              <button
                onClick={startVoice}
                title="语音输入"
                className={`absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                  listening ? "bg-rose-500/30 text-rose-300 animate-pulse" : "text-purple-300/60 hover:text-purple-200"
                }`}
              >
                {listening ? "◉" : "🎙"}
              </button>
            </div>
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
          <p className="mt-5 text-center text-purple-300/40 text-sm tracking-wide">
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
          {/* 等待提示 */}
          {cards.length === 0 && !ask && fanCards.length === 0 && (
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

          {/* 选牌扇面（正常路径：事件携带候选牌） */}
          {ask?.cardSelection && fanCards.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="w-full">
              <CardFan cards={fanCards} count={fanCount} onConfirm={confirmFanSelection} />
            </motion.div>
          )}

          {/* 选牌兜底：事件未携带候选牌时，从前端牌库随机出 7 张（防止白屏死等） */}
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
                onClick={() => answerAsk("random")}
                className="mt-4 px-6 py-3 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm"
              >
                ✦ 代替我随机抽 3 张
              </button>
            </motion.div>
          )}

          {/* 普通问答 / 岔路 */}
          {ask && !ask.cardSelection && (
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10 }}
              className={`w-full max-w-xl mt-6 rounded-3xl backdrop-blur-md p-6 md:p-7 ${
                ask.crossroads
                  ? "border border-amber-500/30 bg-amber-950/10 shadow-[0_0_40px_rgba(245,158,11,0.12)]"
                  : "border border-emerald-500/30 bg-emerald-950/15 shadow-[0_0_40px_rgba(16,185,129,0.12)]"
              }`}
            >
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">{ask.crossroads ? "🔮" : "💭"}</span>
                <span className={`text-sm tracking-wider ${ask.crossroads ? "text-amber-200/90" : "text-emerald-200/90"}`}>
                  {ask.crossroads ? "命运走到了岔路口" : "占卜师想要了解你"}
                </span>
              </div>
              <p className="text-lg md:text-xl text-purple-50/95 leading-relaxed mb-4" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
                {ask.question}
              </p>
              {/* 选项区：无选项时给出明确提示（不能留空白死锁） */}
              {ask.options && ask.options.length > 0 ? (
                <div className="flex flex-col gap-2 mb-3">
                  {ask.options.map((opt) => (
                    <motion.button
                      key={opt}
                      whileHover={{ scale: 1.02, x: 4 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => answerAsk(opt)}
                      className={`text-left px-5 py-3 rounded-xl border transition-all ${
                        ask.crossroads
                          ? "border-amber-500/30 bg-amber-900/20 text-amber-100/90 hover:bg-amber-800/30 hover:border-amber-400/50"
                          : "border-emerald-500/30 bg-emerald-900/20 text-emerald-100/90 hover:bg-emerald-800/30 hover:border-emerald-400/50"
                      }`}
                    >
                      {opt}
                    </motion.button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-amber-200/60 mb-3">
                  ⏳ 占卜师正在铺开选项，请稍候…（也可以直接输入你的想法）
                </p>
              )}
              {/* 自由输入：普通问答恒显示；岔路场景在"有选项"或"选项异常"时可输入
                  （此前 crossroads 时完全隐藏输入框 → options 为空时彻底死锁） */}
              {(!ask.crossroads || !ask.options || ask.options.length === 0) && (
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
              )}
            </motion.div>
          )}

          {/* 卡牌区 */}
          {cards.length > 0 && (
            <div className="flex gap-3 md:gap-8 justify-center flex-wrap mt-4">
              {cards.map((card, i) => (
                <TarotCardView key={`${card.id}-${i}`} card={card} index={i} flipped={flipped[i]} onFlip={handleFlip} />
              ))}
            </div>
          )}

          {/* Agent 状态条 */}
          {(phase || streaming) && (cards.length > 0 || !ask) && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-8">
              <AgentStatusBar phase={phase} />
              {phaseLabel && <p className="mt-2 text-center text-xs text-purple-400/60 tracking-wide">{phaseLabel}</p>}
              {/* 等待反馈：当前步骤已耗时，超过 10 秒提示模型较慢 */}
              {streaming && !ask && <WaitingHint since={streamStart} />}
            </motion.div>
          )}

          {/* 子 Agent 流水线 */}
          <SubAgentPipeline events={subagentEvents} />

          {/* Agent Trace 面板（等待用户输入时明确显示"等待回应"而非误导性的运行中） */}
          <AgentTrace tools={tools} reasoning={reasoning} streaming={streaming && !ask} rounds={rounds} />

          {/* RAG 知识面板 */}
          <KnowledgePanel hits={ragHits} />

          {/* 审校报告 */}
          {review && <ReviewCard review={review} />}

          {/* 解读文本区 */}
          {(reading || error) && (
            <div
              ref={readingBoxRef}
              className="mt-6 w-full max-w-2xl rounded-3xl bg-gradient-to-b from-[#170d24]/85 to-[#0b0514]/85 backdrop-blur-md border border-purple-500/20 p-6 md:p-9 shadow-2xl max-h-[50vh] overflow-y-auto"
            >
              {error ? (
                <p className="text-purple-300/90 text-center py-6">{error}</p>
              ) : (
                <CitedReading text={reading} maxCite={ragHits.length} streaming={streaming} />
              )}
            </div>
          )}

          {/* 追问 */}
          {done && sessionId && (
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-2xl mt-5">
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
                {cards.length > 0 && (
                  <ShareCardButton
                    data={{
                      question,
                      cards: cards.map((c) => ({ nameZh: c.nameZh, image: c.image, reversed: c.reversed, pos: c.pos })),
                      summary: reading.replace(/\s+/g, " ").slice(0, 120),
                      personaName: persona?.name,
                      sessionId,
                    }}
                  />
                )}
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
        </motion.div>
      )}

      {/* 页脚 */}
      <footer className="mt-auto pt-12 pb-6 text-center text-purple-400/25 text-xs tracking-[0.25em] z-10">
        MYSTIC TAROT · MULTI-AGENT × HYBRID RAG (BM25+VECTOR) × HITL × REFLEXION × SSE
      </footer>
    </main>
  );
}
