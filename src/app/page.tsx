"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import StardustCursor from "@/components/StardustCursor";
import AgentTrace, { type ToolCall, type RoundInfo } from "@/components/AgentTrace";
import KnowledgePanel, { type RagHitView } from "@/components/KnowledgePanel";
import CitedReading from "@/components/CitedReading";
import ShareCardButton from "@/components/ShareCard";
import CardSpread, { type SpreadCard } from "@/components/CardSpread";
import CardPreviewModal, { type PreviewCard } from "@/components/CardPreviewModal";
import DialogueFlow, { type FlowEntry } from "@/components/DialogueFlow";
import CardFan, { type FanCard } from "@/components/CardFan";
import ReviewCard, { type ReviewData } from "@/components/ReviewCard";
import SubAgentPipeline, { type SubAgentEvent } from "@/components/SubAgentPipeline";
import { parseAgentEvent } from "@/lib/agent/schema";

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

/* ---------------- Agent 状态条 ---------------- */

function AgentStatusBar({ phase }: { phase: Phase | null }) {
  const order = useMemo(() => {
    if (!phase) return PHASE_ORDER;
    // wait_user / error 不在 PHASE_ORDER 里（是"横切状态"而非流程步骤）：
    // 显示为在当前进度基础上叠加高亮，而不是把状态条塌缩成一项
    const base = PHASE_ORDER.includes(phase as Phase) ? phase : null;
    if (!base) {
      // 横切状态：展示到 interpret 为止（等待/出错发生在解读流程中段）
      return PHASE_ORDER.slice(0, 4);
    }
    const idx = PHASE_ORDER.indexOf(base);
    return PHASE_ORDER.slice(0, Math.max(idx + 1, 1));
  }, [phase]);
  const curIdx = phase && PHASE_ORDER.includes(phase as Phase) ? PHASE_ORDER.indexOf(phase as Phase) : -1;

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
      {/* 横切状态徽章：wait_user / error 不属于流程步骤，单独追加显示 */}
      {phase && !PHASE_ORDER.includes(phase as Phase) && phase !== null && PHASE_TEXT[phase] && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-amber-300/60">→</span>
          <div
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] md:text-xs animate-pulse ${
              phase === "error"
                ? "bg-rose-900/40 border border-rose-400/50 text-rose-100"
                : "bg-amber-900/40 border border-amber-400/50 text-amber-100"
            }`}
          >
            <span>{PHASE_TEXT[phase].icon}</span>
            <span>{PHASE_TEXT[phase].title}</span>
          </div>
        </div>
      )}
    </div>
  );
}

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
  /* cards state 已删除：防剧透改造后 cards 事件是匿名槽位（image/nameZh 空），
     真实牌面状态在 spread 里（对话流牌阵 + 顶部时间线 + 分享卡共用） */
  const [ask, setAsk] = useState<{
    question: string;
    options?: string[];
    cardSelection?: boolean;
    crossroads?: boolean;
    /** HITL 类型：决定用哪个面板渲染 */
    kind?: string;
  } | null>(null);
  const [fanCards, setFanCards] = useState<FanCard[]>([]);
  const [fanCount, setFanCount] = useState(3);
  const [followup, setFollowup] = useState("");
  const [subagentEvents, setSubagentEvents] = useState<SubAgentEvent[]>([]);
  const [review, setReview] = useState<ReviewData | null>(null);
  /* 方向⑤：Plan-Execute 仪轨计划 + 情绪驱动人格建议 */
  const [planSteps, setPlanSteps] = useState<string[]>([]);
  const [personaSuggest, setPersonaSuggest] = useState<{ personaId: string; name: string; emoji: string; reason: string } | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [listening, setListening] = useState(false);
  const [streamStart, setStreamStart] = useState(0);
  /** 过程细节区展开态（默认折叠 = 零渲染开销） */
  const [showDetails, setShowDetails] = useState(false);
  /* ---- 真实塔罗仪式流程状态（仅保留仍在使用的部分；仪式对话已并入对话流）---- */
  /** 逐张解读的牌阵状态（顶部时间线与对话流牌阵**共用这一份** → 天然同步） */
  const [spread, setSpread] = useState<SpreadCard[]>([]);
  /** 放大预览的牌（null = 未打开） */
  const [previewCard, setPreviewCard] = useState<PreviewCard | null>(null);
  /** 用户插话（方案 C） */
  const [interject, setInterject] = useState("");
  /* ---- 对话流（统一视图）---- */
  const [entries, setEntries] = useState<FlowEntry[]>([]);
  /** delta 分流目标：当前 card 条目 id（念牌/解读 delta 流向这里） */
  const deltaTargetRef = useRef<{ type: "card" | "scroll" | "teller"; entryId?: string } | null>(null);
  /** 翻牌请求 pending 标记（防连点：手快连点会发多个 /api/answer） */
  const flipPendingRef = useRef(false);
  /** 条目 id 计数器 */
  const entryIdRef = useRef(0);
  const nextEntryId = () => `e${++entryIdRef.current}`;

  /** 追加一条对话流条目 */
  const pushEntry = useCallback((e: Omit<FlowEntry, "id"> & { id?: string }) => {
    const id = e.id ?? nextEntryId();
    setEntries((prev) => [...prev, { ...e, id } as FlowEntry]);
    return id;
  }, []);

  /** 更新指定条目 */
  const updateEntry = useCallback((id: string, patch: Partial<FlowEntry> | ((e: FlowEntry) => Partial<FlowEntry>)) => {
    setEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...(typeof patch === "function" ? patch(e) : patch) } : e))
    );
  }, []);

  /* ---- delta 节流（rAF 批量合并）----
   * 流式 delta 每秒 20+ 事件，逐条 setEntries 全量 map 会让整页树
   * 每秒重渲染 20+ 次（长会话明显卡顿）。改为：
   *  - delta 到达只写进 bufferRef（零渲染成本）
   *  - requestAnimationFrame 逐帧把缓冲一次性 flush 进 state
   * 一帧内的 N 条 delta 合并为 1 次 setState，渲染次数从"每事件"降到"每帧"。 */
  const deltaBufferRef = useRef<{
    reading: string;
    card: { entryId: string; text: string } | null;
    scroll: { entryId: string; text: string } | null;
    teller: string | null;
  }>({ reading: "", card: null, scroll: null, teller: null });
  const flushScheduledRef = useRef(false);

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
      if (text) setEntries((prev) => prev.map((e) => (e.id === entryId && e.card ? { ...e, card: { ...e.card, reading: (e.card.reading ?? "") + text } } : e)));
      buf.card = null;
    }
    if (buf.scroll) {
      const { entryId, text } = buf.scroll;
      if (text) setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, text: (e.text ?? "") + text } : e)));
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
  }, []);

  const scheduleDeltaFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    requestAnimationFrame(() => flushDeltaBuffer());
  }, [flushDeltaBuffer]);

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

  /**
   * 用户亲手翻牌：点牌阵里的"当前该翻的"牌。
   *
   * 协议：POST /api/answer { answer: "翻牌" } → 后端翻牌闸门 resolve →
   * 后端继续 yield card_reveal（含牌面）→ 前端把这张牌置为已翻开。
   *
   * ⚠️ 牌面**不是**由这个请求返回的 —— 必须等 card_reveal 事件，
   *    这样"用户没点就看不到牌面"才是真的（防剧透）。
   *
   * ⚠️ 409 处理：后端闸门尚未就绪时（极小概率的时序竞争）会返回
   *    409「当前没有等待回答的问题」。此时**静默重试一次**（300ms 后），
   *    不弹错误 —— 用户点牌的动作不该因为一次抢跑就失败，更不该
   *    弹出"对话中断"的错误横幅（实测报告的现象）。
   */
  const flipCard = useCallback(async () => {
    setAsk(null);
    if (!sessionId) return;
    // 本地 pending：防连点（用户手快连点会发多个请求）
    if (flipPendingRef.current) return;
    flipPendingRef.current = true;
    const post = async (): Promise<number> => {
      try {
        const res = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: "翻牌" }),
        });
        return res.status;
      } catch {
        return 0;
      }
    };
    try {
      let status = await post();
      if (status === 409) {
        // 闸门未就绪 → 短暂等待后重试一次（后端 flip_ready 已在闸门就绪后才发，
        // 正常不会走到这里；这是防御性兜底）
        await new Promise((r) => setTimeout(r, 300));
        status = await post();
      }
      if (status === 409 || status === 410) {
        // 仍然失败：会话可能已过期 → 清理本地状态（复用过期处理逻辑）
        if (status === 410) {
          try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
          setSessionId("");
          setError("这场占卜已过期（超过 30 分钟），请重新开始");
        }
        // 409 不弹错：后端 SSE 流还活着，用户再点一次即可
      } else if (status !== 200) {
        const err = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, answer: "翻牌" }),
        }).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
        setError(err.error || "翻牌失败，请重试");
      }
    } finally {
      flipPendingRef.current = false;
    }
  }, [sessionId]);

  /**
   * 放大预览已翻开的牌（只是看，不翻回去）。
   * ⚠️ 牌名/牌面只在此刻可见 —— 未翻开的牌连名字都不给（防剧透）。
   */
  const openCardPreview = useCallback((index: number) => {
    setSpread((prev) => {
      const c = prev[index];
      if (!c || !c.flipped) return prev;
      // 从对话流的牌面条目取牌意（牌阵面板只存了基础信息）
      setEntries((entriesNow) => {
        const cardEntry = [...entriesNow].reverse().find((e) => e.kind === "card" && e.card?.cardIndex === index);
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
  }, []);

  /** 关闭放大预览 */
  const closePreview = useCallback(() => setPreviewCard(null), []);

  /** 展开/收起条目 */
  const toggleEntry = useCallback((entryId: string) => {
    setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, collapsed: !e.collapsed } : e)));
  }, []);

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
        // ⚠️ 会话存活探测（用户实测报告的 bug）：
        // 此前只要 localStorage 有 sessionId 就显示"可追问"面板，
        // 但内存会话有 30min TTL——过期后面板还在，用户追问直接
        // 撞"会话已过期，请重新开始占卜"。
        // 现在挂载时用恢复端点探测：404 = 会话已消失 → 清掉本地
        // 记录并隐藏面板（sessionId 置空）；活着才回填。
        fetch(`/api/session/${saved}`)
          .then(async (r) => {
            if (r.ok) {
              setSessionId((cur) => (cur ? cur : saved));
            } else {
              // 会话已过期/不存在：清本地，别再展示"可追问"入口
              try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
              setSessionId("");
            }
          })
          .catch(() => {
            // 探测失败（网络/服务未就绪）：保守起见不回填（宁可让用户重新开始）
            try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
          });
      } catch { /* 隐私模式 */ }
    });
  }, []);

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
          // ⚠️ zod schema 解析（前后端单一事实源）：
          //    协议不匹配时返回 null → 跳过这一条，**不丢弃整场对话**。
          //    之前这里是 JSON.parse + any，字段写错要到渲染时才炸。
          const p = parseAgentEvent(line.slice(5).trim());
          if (!p) continue;
          switch (p.type) {
            case "session":
              setSessionId(p.sessionId);
              // 持久化：刷新后可恢复会话继续追问（十几分钟的仪式流程不该因刷新作废）
              try { localStorage.setItem("tarot:sessionId", p.sessionId); } catch { /* 隐私模式 */ }
              break;
            case "phase":
              setPhase(p.phase ?? null);
              if (p.label) setPhaseLabel(p.label);
              // 收束阶段：建"命运之卷"条目，后续收束 delta 流向它
              // （含 write_reading 综合正文与 close_reading 收束语）
              if (p.label && (p.label.includes("收束") || p.label.includes("子 Agent 管线启动"))) {
                // 已有 scroll 条目则复用（收束语接在综合正文后）
                setEntries((prev) => {
                  const lastScroll = [...prev].reverse().find((e) => e.kind === "scroll");
                  if (lastScroll) {
                    deltaTargetRef.current = { type: "scroll", entryId: lastScroll.id };
                    return prev;
                  }
                  const sid = nextEntryId();
                  deltaTargetRef.current = { type: "scroll", entryId: sid };
                  return [...prev, { id: sid, kind: "scroll", title: "命运之卷 · 综合与收束", text: "", collapsed: false } as FlowEntry];
                });
              }
              break;
            case "reasoning":
              setReasoning((prev) => (prev + p.reasoning).slice(-4000));
              break;
            case "tool":
              // ⚠️ 组件的 ToolCall 类型比 wire 格式更严（args/resultSummary/durationMs 非可选）。
              //    这里显式补默认值 —— 让"协议可选"与"视图必需"在边界处对齐，
              //    而不是把可选性传染给所有消费方。
              setTools((prev) => [
                ...prev,
                {
                  name: p.tool.name,
                  args: (p.tool.args ?? {}) as Record<string, unknown>,
                  resultSummary: p.tool.resultSummary ?? "",
                  durationMs: p.tool.durationMs ?? 0,
                },
              ]);
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
              // ⚠️ 防剧透：cards 事件**只含位置**（id/nameZh/image 为空占位），
              //    牌名与图片要等用户亲手翻开（card_reveal）才补上。
              //    直接初始化 spread（对话流牌阵 + 顶部时间线 + 分享卡共用）。
              // 初始化牌阵（逐张手动翻牌）：全部牌背，第 0 张为"当前该翻的"
              if (Array.isArray(p.cards) && p.cards.length > 0) {
                const initial: SpreadCard[] = (p.cards as AgentCard[]).map((c, i) => ({
                  index: i,
                  id: c.id || `slot-${i}`,
                  nameZh: c.nameZh ?? "",
                  image: c.image ?? "",
                  reversed: c.reversed,
                  pos: c.pos,
                  done: false,
                  active: false,
                  flipped: false,
                  current: i === 0,
                }));
                setSpread(initial);
                // 牌阵面板插入对话流（常驻条目，后续原地更新状态）
                pushEntry({
                  kind: "spread",
                  spread: initial.map((c) => ({
                    index: c.index,
                    id: c.id,
                    nameZh: c.nameZh,
                    image: c.image,
                    reversed: c.reversed,
                    pos: c.pos,
                    flipped: c.flipped,
                    done: c.done,
                    current: c.current,
                  })),
                });
              }
              break;
            case "ask_user":
              setAsk({
                question: p.ask.question,
                options: p.ask.options,
                cardSelection: p.cardSelection,
                crossroads: p.crossroads,
                kind: p.ask.kind,
              });
              if (p.cardSelection) {
                // 候选扇面由 ask_user 事件直接携带（7 张随机牌）
                if (Array.isArray(p.fanCards) && p.fanCards.length > 0) setFanCards(p.fanCards);
                setFanCount(p.fanCount ?? 3);
              }
              setPhase("wait_user");
              // ---- 对话流映射 ----
              if (p.ask?.kind === "card_confirm") {
                // 牌面确认：挂到当前激活的 card 条目上
                setEntries((prev) => {
                  const lastCard = [...prev].reverse().find((e) => e.kind === "card");
                  if (!lastCard?.card) return prev;
                  return prev.map((e) =>
                    e.id === lastCard.id
                      ? { ...e, card: { ...e.card!, question: p.ask.question, options: p.ask.options } }
                      : e
                  );
                });
              } else {
                // 其余（承约/呼召/澄清/岔路/收束/继续）：插入待回答条目
                pushEntry({
                  kind: "ask",
                  ask: {
                    question: p.ask.question,
                    options: p.ask.options,
                    kind: p.ask.kind,
                    cardSelection: p.cardSelection,
                    crossroads: p.crossroads,
                  },
                });
              }
              break;
            /* ---- 真实塔罗仪式流程事件（同时映射进对话流） ---- */
            case "contract":
              // 对话流：占卜师说承约语（问题本身由随后的 ask_user 事件建面板）
              if (p.contract) {
                pushEntry({
                  kind: "teller",
                  text: `我听到的是——${p.contract.question}${p.contract.scope ? `\n（本次牌阵：${p.contract.scope}）` : ""}`,
                });
              }
              break;
            case "invocation":
              // 对话流：呼召由随后的 ask_user（kind=invocation）建三问面板
              break;
            case "card_reveal": {
              const r = p.cardReveal;
              if (r) {
                // 更新牌阵：这张牌已翻开（flipped=true）→ 显示牌面
                // ⚠️ 牌名/图片此刻才补上（cards 事件只给了位置，防剧透）
                // ⚠️ 同时清掉所有 current：这张已经翻开了，"当前该翻的"
                //    应该是**下一张**（由随后的 card_flip_ready 置上）。
                //    不清的话 current 会一直挂在刚翻开的这张上 →
                //    牌阵面板在"模型正在输出解读"期间也保持展开，挡住正文
                //    （用户诉求：大模型输出时自动收起翻牌面板）。
                setSpread((prev) => {
                  const list = prev.length > 0 ? prev : [];
                  const next = list.map((c, i) =>
                    i === r.cardIndex
                      ? { ...c, flipped: true, active: true, current: false, nameZh: r.nameZh, image: r.image, reversed: r.reversed }
                      : { ...c, active: false, current: false }
                  );
                  if (next.length === 0) {
                    // 首次收到：构造完整牌阵（当前牌 + 后续待翻）
                    return [{ ...r, index: r.cardIndex, done: false, active: true, flipped: true, current: false } as SpreadCard];
                  }
                  return next;
                });
                // 牌面已下发 → 同步到牌阵面板条目（牌名/牌意此时才可见）
                // ⚠️ 同时清掉 current（与上面 setSpread 一致）：
                //    翻开的这张不再是"当前该翻的"，牌阵面板据此自动收起，
                //    等下一张的 card_flip_ready 到达再自动展开。
                setEntries((prev) =>
                  prev.map((e) =>
                    e.kind === "spread" && e.spread
                      ? {
                          ...e,
                          spread: e.spread.map((c) =>
                            c.index === r.cardIndex
                              ? { ...c, flipped: true, current: false, nameZh: r.nameZh, image: r.image, reversed: r.reversed, meaning: r.meaning }
                              : { ...c, current: false }
                          ),
                        }
                      : e
                  )
                );
                // 翻牌闸门的提示面板已过期 → 收掉它。
                // ⚠️ 但**不能覆盖用户说的话**：若用户是通过闸门输入框插话
                //    （"我未来那段——那团火"），answerFlowAsk 已把该条目
                //    settle 成用户气泡 —— 此处若再改写文案，会把用户的话
                //    覆盖成"✦ 你翻开了这张牌"（实测报告：用户的话消失了）。
                //    只处理**仍未 settle** 的（用户是点牌完成的）。
                setEntries((prev) =>
                  prev.map((e) =>
                    e.kind === "ask" && !e.settled && e.ask?.kind === "flip"
                      ? { ...e, settled: true, kind: "teller", text: "✦ 你翻开了这张牌", ask: undefined }
                      : e
                  )
                );
                // ---- 对话流：新建 card 条目（念牌内容直接带上）----
                const entryId = nextEntryId();
                pushEntry({
                  id: entryId,
                  kind: "card",
                  card: {
                    cardIndex: r.cardIndex,
                    nameZh: r.nameZh,
                    image: r.image,
                    reversed: r.reversed,
                    pos: r.pos,
                    narrative: r.narrative,
                    meaning: r.meaning,
                    revealed: true,
                    readingDone: false,
                  },
                });
                // 后续该牌的解读 delta 流向这个条目
                deltaTargetRef.current = { type: "card", entryId };
                // 翻新牌时：把之前的牌折叠为摘要行（保持时间线整洁）
                setEntries((prev) =>
                  prev.map((e) =>
                    e.kind === "card" && e.card && e.card.cardIndex !== r.cardIndex && e.card.readingDone && !e.collapsed
                      ? { ...e, collapsed: true }
                      : e
                  )
                );
              }
              break;
            }
            case "card_reading": {
              const cr = p.cardReading;
              if (cr) {
                setSpread((prev) => prev.map((c, i) => (i === cr.cardIndex ? { ...c, done: true, active: false } : c)));
                // 牌阵面板同步：这张牌解读完成（金框 + ✓）
                setEntries((prev) =>
                  prev.map((e) =>
                    e.kind === "spread" && e.spread
                      ? { ...e, spread: e.spread.map((c) => (c.index === cr.cardIndex ? { ...c, done: true } : c)) }
                      : e
                  )
                );
                // ---- 对话流：标记该牌解读完成 ----
                // ⚠️ **不再覆盖 reading**：正文已由 delta 流式累积到 e.card.reading。
                //    旧设计用 cr.text 覆盖 → 与 delta 缓冲形成双数据源，
                //    rAF 分帧竞争时残留 delta 被追加一次 → 整段输出两遍
                //    （用户实测报告）。这里只置完成标记，正文只由 delta 写。
                setEntries((prev) =>
                  prev.map((e): FlowEntry => {
                    if (e.kind !== "card" || e.card?.cardIndex !== cr.cardIndex) return e;
                    return { ...e, card: { ...e.card!, readingDone: true }, collapsed: false };
                  })
                );
                deltaTargetRef.current = null;
              }
              break;
            }
            /* ---- 逐张翻牌闸门：第 N 张可以翻了（⚠️ 事件不含牌面，防剧透）---- */
            case "card_flip_ready": {
              const fr = p.cardFlipReady;
              if (fr) {
                // 顶部时间线：标记该张为"当前该翻的"，其余取消 current
                setSpread((prev) =>
                  prev.map((c, i) => (i === fr.cardIndex ? { ...c, current: true } : { ...c, current: false }))
                );
                // 牌阵面板同步（此时牌名仍未下发 —— 未翻开的牌显示 "？"）
                setEntries((prev) =>
                  prev.map((e) =>
                    e.kind === "spread" && e.spread
                      ? { ...e, spread: e.spread.map((c) => (c.index === fr.cardIndex ? { ...c, current: true } : { ...c, current: false })) }
                      : e
                  )
                );
              }
              break;
            }
            case "subagent":
              setSubagentEvents((prev) => [...prev, p.subagent]);
              break;
            /* 方向⑤：Plan-Execute 计划 / 情绪人格建议 */
            case "plan":
              setPlanSteps(p.plan ?? []);
              break;
            case "persona_suggest":
              setPersonaSuggest(p.personaSuggest ?? null);
              break;
            case "round":
              setRounds((prev) => [...prev, p.round]);
              break;
            case "review":
              // ⚠️ 组件的 ReviewData 要求 comment 非空 —— 协议里是可选的
              //    （解析失败时 review.comment 仍会给一个说明，但协议层允许缺省）。
              //    在边界处补默认值，不把可选性传染给消费方。
              setReview({
                pass: p.review.pass,
                scores: p.review.scores,
                comment: p.review.comment ?? "",
                rewritten: p.review.rewritten,
              });
              break;
            case "delta": {
              const d = p.delta ?? "";
              if (!d) break;
              // ---- 节流：只写缓冲，rAF 统一 flush（见 deltaBufferRef） ----
              const target = deltaTargetRef.current;
              deltaBufferRef.current.reading += d; // 完整正文仍累积（分享卡/落库用）
              if (target?.type === "card" && target.entryId) {
                const t = target.entryId;
                // 同帧多条 delta 合并进同一目标
                if (deltaBufferRef.current.card?.entryId === t) {
                  deltaBufferRef.current.card.text += d;
                } else {
                  deltaBufferRef.current.card = { entryId: t, text: d };
                }
              } else if (target?.type === "scroll" && target.entryId) {
                const t = target.entryId;
                if (deltaBufferRef.current.scroll?.entryId === t) {
                  deltaBufferRef.current.scroll.text += d;
                } else {
                  deltaBufferRef.current.scroll = { entryId: t, text: d };
                }
              } else {
                // 无目标：占卜师的开场白/回应 → teller 气泡
                deltaBufferRef.current.teller = (deltaBufferRef.current.teller ?? "") + d;
              }
              scheduleDeltaFlush();
              break;
            }
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
  }, [pushEntry, scheduleDeltaFlush]);

  /* 开始占卜 */
  const startDivination = useCallback(async () => {
    // ⚠️ 连点防护：流式进行中再触发会并发两个 SSE 流交错写同一批 state
    if (streaming) return;
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
    setAsk(null);
    setFanCards([]);
    setSubagentEvents([]);
    setReview(null);
    setPhase(null);
    setPhaseLabel("");
    /* 仪式流程状态重置 */
    setSpread([]);
    setInterject("");
    /* 对话流重置：用户的问题作为第一条气泡 */
    setEntries([{ id: nextEntryId(), kind: "user", text: q } as FlowEntry]);
    deltaTargetRef.current = null;
    setStage("drawing");
    setStreaming(true);
    setStreamStart(Date.now());

    try {
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, persona: persona?.id, userKey: getUserKey() }),
      });
      await consumeStream(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "解读失败，请重试");
    } finally {
      setStreaming(false);
    }
  }, [question, persona, consumeStream, streaming]);

  /* HITL 应答（选牌扇面 / 随机代抽等仍在流外的交互）。
     ⚠️ 提交锁：双击选项/按钮会双发 POST，第二次 409 报错干扰用户 */
  const answeringRef = useRef(false);
  const answerAsk = useCallback(async (answer: string) => {
    if (!answer.trim() || !sessionId) return;
    if (answeringRef.current) return; // 防连点
    answeringRef.current = true;
    setAsk(null);
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

  /* 选牌确认（扇面选完 / 随机代抽）——流内 ask 条目同步转为用户气泡 */
  const confirmFanSelection = useCallback((payload: string) => {
    // 选牌详情（"id,id,id|dwell,ms"）转为可读描述
    const [idsStr] = payload.split("|");
    const count = idsStr.split(",").filter(Boolean).length;
    const label = payload.trim() === "random" || count === 0
      ? "请星辰替我选（随机 3 张）"
      : `我亲手选了 ${count} 张牌`;
    // 把流内未 settle 的选牌 ask 条目固定为用户气泡
    setEntries((prev) => {
      const idx = [...prev].reverse().findIndex((e) => e.kind === "ask" && !e.settled && e.ask?.cardSelection);
      if (idx === -1) return prev;
      const realIdx = prev.length - 1 - idx;
      return prev.map((e, i) => (i === realIdx ? { ...e, settled: true, kind: "user", text: label, ask: undefined } : e));
    });
    answerAsk(payload);
  }, [answerAsk]);

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
  }, [interject, sessionId, pushEntry]);

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
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, followup: f }),
      });
      if (!res.ok && res.status === 410) {
        // ⚠️ 会话已被 TTL 清理/服务重启丢失：立即清掉本地会话记录，
        // 让"可追问"面板消失（用户实测报告：过期了还挂在页面上）。
        // 错误文案由下方 setError 呈现，"重新开始"是唯一出路。
        try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
        setSessionId("");
        setError("这场占卜已过期（超过 30 分钟），请重新开始");
        return;
      }
      await consumeStream(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "追问失败");
    } finally {
      setStreaming(false);
    }
  }, [followup, sessionId, consumeStream, pushEntry, streaming]);

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

  const restart = useCallback(() => {
    setStage("input");
    setSessionId("");
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
    /* 仪式流程状态重置 */
    setSpread([]);
    setInterject("");
    /* 对话流重置 */
    setEntries([]);
    deltaTargetRef.current = null;
    entryIdRef.current = 0;
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
          {error && (
            <div className="mt-3 flex items-center gap-2 text-purple-400/90 text-sm text-center sm:text-left">
              <span>⚠️</span>
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
          {/* 上次会话可继续（刷新后 sessionId 已从 localStorage 恢复）。
              ⚠️ !error：追问撞 410 过期后立即隐藏（session 已清，留着必失败） */}
          {sessionId && !streaming && !error && (
            <div className="mt-4 rounded-2xl border border-purple-500/25 bg-purple-950/20 px-4 py-3 text-center">
              <p className="text-xs text-purple-300/60 mb-2">检测到上次未完结的占卜，可以直接追问（不用重新走仪式）</p>
              <div className="flex gap-2 justify-center">
                <input
                  className="flex-1 max-w-xs px-3.5 py-2 rounded-xl bg-purple-950/40 border border-purple-500/30 text-purple-50 placeholder-purple-300/40 focus:outline-none focus:border-purple-400/60 text-sm"
                  style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                  placeholder="继续问点什么…"
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
          {/* ---------- 牌阵横条（固定顶部，进度可见；与对话流牌阵同一份状态）---------- */}
          {spread.length > 0 && (
            <CardSpread cards={spread} onFlipCard={flipCard} onPreview={openCardPreview} />
          )}

          {/* ---------- Agent 状态条 ---------- */}
          {(phase || streaming) && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
              <AgentStatusBar phase={phase} />
              {phaseLabel && <p className="mt-2 text-center text-xs text-purple-400/60 tracking-wide">{phaseLabel}</p>}
              {streaming && !ask && <WaitingHint since={streamStart} />}
            </motion.div>
          )}

          {/* ---------- 方向⑤：仪轨计划（Plan-Execute 模式可见）---------- */}
          {planSteps.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-3 w-full max-w-2xl rounded-2xl border border-indigo-500/25 bg-indigo-950/15 backdrop-blur-md px-5 py-3"
            >
              <p className="text-[11px] text-indigo-300/70 tracking-[0.25em] mb-1.5">PLAN · 仪轨路线图</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {planSteps.map((s, i) => (
                  <span key={i} className="text-xs text-purple-200/75">
                    <span className="text-indigo-400/80">{i + 1}.</span> {s.replace(/^[①②③④⑤⑥⑦⑧\d.、)\s]+/, "")}
                  </span>
                ))}
              </div>
            </motion.div>
          )}

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
              <span className="text-base shrink-0">⚠️</span>
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
