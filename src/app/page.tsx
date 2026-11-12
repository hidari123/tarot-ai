"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { motion } from "framer-motion";
import StardustCursor from "@/components/StardustCursor";
/**
 * ⚠️ 2026-11-05 视觉重设计：新的视觉基底
 *   · CelestialBackdrop —— 深空星云背景（含噪点/景深/暗角）
 *   · AstralCircle —— 真 SVG 星象魔法阵
 */
import CelestialBackdrop from "@/components/CelestialBackdrop";
import WitchOrb from "@/components/WitchOrb";
import PersonaOrb from "@/components/PersonaOrb";
import AgentTrace, { type ToolCall, type RoundInfo } from "@/components/AgentTrace";
import KnowledgePanel, { type RagHitView } from "@/components/KnowledgePanel";
import CitedReading from "@/components/CitedReading";
import CardSpread, { type SpreadCard } from "@/components/CardSpread";
import CardPreviewModal, { type PreviewCard } from "@/components/CardPreviewModal";
import DialogueFlow, { type FlowEntry } from "@/components/DialogueFlow";
import CardFan, { type FanCard } from "@/components/CardFan";
import ReviewCard, { type ReviewData } from "@/components/ReviewCard";
import AmbienceToggle, { useAmbiencePhase } from "@/components/AmbienceToggle";
import { DEFAULT_MODE, MODE_PROFILES, type DivinationMode } from "@/lib/agent/divination-mode";
import ClosingPanel from "@/components/ClosingPanel";
import Icon, { type IconName } from "@/components/icons";

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
import type { SubAgentEvent } from "@/components/SubAgentPipeline";

const ShareCardButton = dynamic(
  () => import("@/components/ShareCard").then((m) => m.default),
  { ssr: false, loading: () => null }
);
const SubAgentPipeline = dynamic(
  () => import("@/components/SubAgentPipeline").then((m) => m.default),
  { ssr: false, loading: () => null }
);
import { unlockAmbience, playSfx } from "@/lib/audio/ambient";import { parseAgentEvent } from "@/lib/agent/schema";

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

/**
 * ⚠️ 2026-11-04：图标从 emoji 换成 **SVG 线条图标**（用户诉求："想要更漂亮一点的图标"）
 * ⚠️ 原因见 `src/components/icons.tsx` 的头注释：
 *   emoji 跨平台不一致（Windows/macOS/Android 三种长相）、
 *   Linux 上可能渲染成豆腐块、且与"暗紫金线"的古典调性不搭。
 */
const PHASE_TEXT: Record<Phase, { title: string; icon: IconName }> = {
  analyze: { title: "凝听问题", icon: "crystal" },
  draw: { title: "命运之牌", icon: "cards" },
  retrieve: { title: "翻阅典籍", icon: "book" },
  interpret: { title: "撰写命运之卷", icon: "quill" },
  wait_user: { title: "等待你的回应", icon: "thought" },
  review: { title: "审校检视", icon: "eye" },
  done: { title: "解读完成", icon: "sparkle" },
  error: { title: "波动", icon: "orbit" },
};

const PHASE_ORDER: Phase[] = ["analyze", "draw", "retrieve", "interpret", "review", "done"];

/* ---------------- 星空 & 魔法阵 ---------------- */

/**
 * ⚠️ 2026-11-05 视觉重设计：原来的 StarField 与 MagicCircle 已被替换。
 *   · StarField  → CelestialBackdrop（含星云/噪点/景深/暗角）
 *   · MagicCircle → AstralCircle（真 SVG：刻度/八芒星/星座环/元素符号）
 */

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
    /**
     * ⚠️ 2026-11-05 视觉重设计：从「药丸步骤条」改成「符文路径」。
     *
     * ⚠️ 为什么改：
     *   原来是一排圆角药丸 + "→" 箭头 —— 那是一个 **loading 步骤条**
     *   （像 CI 进度条），完全没有"仪轨"的感觉。
     *   → 改成：符文节点 + 发光连线（连续的光带 = 一条路）。
     *   节点是符文（每个阶段一个符号），当前节点有呼吸光。
     */
    <div className="flex items-center gap-0 flex-wrap justify-center">
      {order.map((p, i) => {
        const active = i === curIdx;
        const past = i < curIdx;
        return (
          <div key={p} className="flex items-center">
            {i > 0 && (
              /* 连线：已走过的是亮色光带，未走的是暗线 */
              <span
                className="w-5 sm:w-7 h-px mx-0.5 transition-colors duration-500"
                style={{
                  background: past
                    ? "linear-gradient(90deg, rgba(212,175,55,0.6), rgba(168,85,247,0.5))"
                    : "rgba(120,113,150,0.22)",
                  boxShadow: past ? "0 0 6px rgba(168,85,247,0.4)" : undefined,
                }}
              />
            )}
            {/* 节点：符文 + 标题 */}
            <div
              className="flex items-center gap-1.5 px-1.5 transition-all duration-500"
              style={{ opacity: active ? 1 : past ? 0.82 : 0.42 }}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-500 ${
                  active ? "animate-pulse" : ""
                }`}
                style={{
                  border: `1px solid ${
                    active
                      ? "rgba(212,175,55,0.75)"
                      : past
                        ? "rgba(168,85,247,0.45)"
                        : "rgba(120,113,150,0.22)"
                  }`,
                  background: active
                    ? "radial-gradient(circle at 34% 28%, rgba(120,72,190,0.85), rgba(20,10,42,0.9))"
                    : past
                      ? "rgba(30,18,58,0.7)"
                      : "rgba(16,12,30,0.5)",
                  boxShadow: active
                    ? "0 0 16px rgba(212,175,55,0.45)"
                    : past
                      ? "0 0 8px rgba(139,92,246,0.2)"
                      : undefined,
                }}
              >
                <Icon
                  name={PHASE_TEXT[p].icon}
                  size={12}
                  className={active ? "text-amber-100" : past ? "text-purple-200/80" : "text-purple-300/40"}
                />
              </span>
              <span
                className={`text-[11px] md:text-xs tracking-[0.1em] whitespace-nowrap ${
                  active ? "text-amber-100" : past ? "text-purple-200/75" : "text-purple-300/40"
                }`}
              >
                {PHASE_TEXT[p].title}
              </span>
            </div>
          </div>
        );
      })}
      {/* 横切状态徽章：wait_user / error 不属于流程步骤，单独追加显示 */}
      {phase && !PHASE_ORDER.includes(phase as Phase) && phase !== null && PHASE_TEXT[phase] && (
        <div className="flex items-center">
          <span
            className="w-5 sm:w-7 h-px mx-0.5"
            style={{ background: "rgba(212,175,55,0.35)" }}
          />
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] md:text-xs animate-pulse ${
              phase === "error"
                ? "bg-rose-900/40 border border-rose-400/50 text-rose-100"
                : "bg-amber-900/40 border border-amber-400/50 text-amber-100"
            }`}
          >
            <Icon name={PHASE_TEXT[phase].icon} size={13} />
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

/**
 * 等待反馈：显示已等待时长
 *
 * ⚠️⚠️ 2026-11-04 重写：**去技术化 + 分级**
 *
 * ⚠️ 之前的问题（用户诉求："别让用户感知到限流"）：
 *   原文案直接写了"正在控制请求节奏以避免服务端限流…"
 *   → 用户看到"限流"两个字立刻不安（而且他确实什么都没做错）。
 *   原文案还有"模型仍在思考…（模型较慢，可查看下方时间轴定位瓶颈）"
 *   → 把**内部术语**和**排查指引**塞进了主界面。
 *
 * ⚠️ 原则（写进注释，避免以后被改回去）：
 *   **内部术语（限流/429/配额/模型/超时/熔断）一律不出现在用户界面。**
 *   用户关心的是"占卜师在想"，不是"我们的 API 在限流"。
 *   技术细节属于**下方时间轴/诊断面板**（那才是给排查用的，且默认折叠）。
 *
 * ⚠️ 分级（为什么这样切）：
 *   · < 3s   → **什么都不显示**（用户注意不到；显示反而像"卡住了"）
 *   · 3~10s → 一句轻提示（"占卜师在斟酌…"）
 *   · > 10s → 换一句**有内容**的（占卜师口吻），让等待变成氛围的一部分
 */
function WaitingHint({ since, rateLimited }: { since: number; rateLimited?: boolean }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - since) / 1000)), 500);
    return () => clearInterval(t);
  }, [since]);

  if (!since || elapsed < 3) return null;
  const slow = elapsed >= 10;
  /**
   * ⚠️ rateLimited 保留但**不用于文案**（2026-11-04）
   *   原因：用户诉求"别让用户感知到限流"——
   *   原文案直接写了"正在控制请求节奏以避免服务端限流"，
   *   用户看到"限流"两个字立刻不安（而且他什么都没做错）。
   *   → 两种等待（我们主动限速 / 模型真的慢）**对用户的感受是一样的**：
   *     都是"占卜师在想"。文案不该区分，也**不该暴露技术细节**。
   *   ⚠️ 参数保留是为了将来做**埋点**（想知道限流对等待时长的贡献有多大），
   *   而不是为了显示给用户。
   */
  void rateLimited;

  /**
   * ⚠️ 占卜师口吻的短句池
   *   · ⚠️ 刻意**不显示"限流"字样** —— 那是我们的内部实现细节
   *   · rateLimited 与否，用户看到的都是"占卜师在斟酌"（两种情况的**感受**相同）
   *   · 用轮换而不是固定文案：固定文案重复出现会显得很假
   */
  const PHRASES = [
    "占卜师在斟酌这句话背后的意思…",
    "让我再对照一下典籍里的说法…",
    "稍等，我在想这张牌该怎么落…",
    "有几处细节想再确认一下…",
    "正在把牌面的话连成一条线…",
  ];
  // ⚠️ 用 elapsed 做索引 → 每隔几秒换一句（不随重渲染跳动）
  const phrase = PHRASES[Math.floor(elapsed / 6) % PHRASES.length];

  return (
    <motion.p
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={`mt-1.5 text-center text-xs tracking-wide ${
        slow ? "text-purple-300/70" : "text-purple-400/50"
      }`}
    >
      {slow ? (
        <>
          {phrase}
          <span className="text-purple-400/40"> · 已等待 {elapsed}s</span>
        </>
      ) : (
        <span className="text-purple-400/40">{elapsed}s</span>
      )}
    </motion.p>
  );
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
 */
const STAGE_GONG_PHASES = ["invocation", "card_selection", "synthesis", "closing"];

export default function TarotApp() {
  const [question, setQuestion] = useState("");
  const [persona, setPersona] = useState<PersonaView | null>(null);
  /**
   * ⚠️ 2026-11-04 双模式：占卜模式（快速一问 / 深度解读）
   * ⚠️ 默认「快速」—— 降低首次体验门槛（用户平均只花 45 秒），
   *   深度模式留给愿意等的人。
   */
  const [mode, setMode] = useState<DivinationMode>(DEFAULT_MODE);
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [stage, setStage] = useState<"input" | "drawing" | "reading">("input");
  const [sessionId, setSessionId] = useState("");
  const [phase, setPhase] = useState<Phase | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
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
  const [rateLimited, setRateLimited] = useState(false);
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
  const [canFollowup, setCanFollowup] = useState(false);
  /** 追问输入框的 ref（落点卡片的"我想再问一句"要聚焦它） */
  const followupInputRef = useRef<HTMLInputElement>(null);
  /** 分享卡区域的 ref（落点卡片的"保存解读卡片"要滚到它） */
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  /**
   * ⚠️ 轻提示（2026-11-04 新增）
   * ⚠️ 与 error 的区别（这是刻意的）：
   *   · error    → **错误横幅**（红色）：出错了，用户需要知道出了什么问题
   *   · hint    → **轻提示**（柔和）：只是一句状态说明（如"稍等一下再点"）
   * ⚠️ 为什么需要它：翻牌 409 之前是**完全静默**的 → 用户以为牌坏了。
   *   但用 error 横幅又太重（那不是错误，只是"还没准备好"）。
   */
  const [hint, setHint] = useState("");
  const [listening, setListening] = useState(false);
  const [streamStart, setStreamStart] = useState(0);
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
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
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
  /** 最后收到的 SSE 事件序号（断点续传用，P1-③D） */
  const lastSeqRef = useRef(0);
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
   * 在途 SSE 请求的取消句柄（P0-③）
   *
   * ⚠️ 为什么必须有（后端的断开检测形同虚设）：
   *   后端有完整的 `req.signal → client_disconnect → 停止烧 token` 逻辑，
   *   但前端 fetch **从不 abort** → req.signal 永远不触发 → 那段代码是死代码。
   *   后果：用户误点「重新开始」→ 旧流继续跑完整场仪式（14 次 LLM 往返）
   *   → 白烧约 ¥0.22 的 token，而且后端还把它记成"正常完成"。
   */
  const streamAbortRef = useRef<AbortController | null>(null);
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
    flushRafRef.current = requestAnimationFrame(() => flushDeltaBuffer());
  }, [flushDeltaBuffer]);

  // ⚠️ P2-㉒：卸载时取消待执行的 rAF（否则 setState 打到已卸载组件）
  useEffect(() => {
    return () => {
      if (flushRafRef.current != null) cancelAnimationFrame(flushRafRef.current);
    };
  }, []);

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
    // ⚠️ 翻牌音效：木质"嗒"—— 这是仪式里最有仪式感的一下，值得给声音
    void playSfx("flip");
    if (!sessionId) return;
    // 本地 pending：防连点（用户手快连点会发多个请求）
    if (flipPendingRef.current) return;
    flipPendingRef.current = true;

    /**
     * ⚠️⚠️ 2026-11-04 新增：**本地乐观反馈**
     *
     * ⚠️ 用户实测报告："牌出现了，但有时候点的无效"。
     *   根因：点击 → POST → 等后端 200 → 等 SSE 的 card_reveal 事件到达
     *        → 牌面才变化。**网络慢时看起来就是"点了没反应"**。
     *   而且前端只把 `current: true` 的牌当可点，
     *   card_flip_ready 到达前的牌**完全点不动**（用户以为是坏的）。
     *
     *   修法：点击**立刻**把该牌置为 `flipping`（本地状态）→
     *        播 3D 翻转动画 + "翻开中"遮罩 → 用户立刻有反馈。
     *   ⚠️ 落定仍由后端事件（card_reveal）负责 —— 乐观更新只是"提前回应"，
     *      不改变数据来源。如果后端最终失败，flipping 会被清掉。
     */
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
         *   ⚠️ 之前弹"这场占卜已过期（超过 30 分钟），请重新开始"——
         *     但正文还在 DB 里，弹这个会让用户以为解读丢了。
         */
        setSpread((prev) => prev.map((c) => (c.flipping ? { ...c, flipping: false } : c)));
        if (status === 410) {
          try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
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
        //   原来的代码在失败分支里重新 fetch 同一个 /api/answer ——
        //   结果是"一次点击可能打两次后端"（第二次必然 409/422），
        //   而取到的 err.error 其实来自那次多余的请求。
        //   正确做法：用 post() 已经带回来的错误体，不重发。
        setSpread((prev) => prev.map((c) => (c.flipping ? { ...c, flipping: false } : c)));
        setError(err.error || "翻牌失败，请重试");
      }
    } catch {
      setSpread((prev) => prev.map((c) => (c.flipping ? { ...c, flipping: false } : c)));
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
  useEffect(() => {
    return () => {
      const ctrl = streamAbortRef.current;
      if (ctrl) ctrl.abort();
    };
  }, []);

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
  const consumeStream = useCallback(async (res: Response) => {    if (!res.ok || !res.body) {
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
        // ⚠️ SSE 帧可能含多行：`id: <seq>` + `data: <json>`
        //    旧实现只认 data: 行 → id 被丢弃，断点续传无从谈起。
        let seq = 0;
        let dataLine = "";
        for (const raw of evt.split("\n")) {
          const line = raw.trim();
          if (line.startsWith("id:")) {
            seq = Number(line.slice(3).trim()) || 0;
          } else if (line.startsWith("data:")) {
            dataLine = line.slice(5).trim();
          }
        }
        if (!dataLine) continue;
        // 记录最后收到的 seq（断点续传用）
        if (seq > 0) lastSeqRef.current = seq;
        try {
          // ⚠️ zod schema 解析（前后端单一事实源）：
          //    协议不匹配时返回 null → 跳过这一条，**不丢弃整场对话**。
          //    之前这里是 JSON.parse + any，字段写错要到渲染时才炸。
          const p = parseAgentEvent(dataLine);
          if (!p) continue;
          switch (p.type) {
            case "session":
              setSessionId(p.sessionId);
              // P0-③：同步 ref 镜像（断点续传的 catch 块要读最新值）
              sessionIdRef.current = p.sessionId;
              // ⚠️ 2026-11-04：新会话刚建立 → 追问**一定可用**（还在内存里）
              setCanFollowup(true);
              // 持久化：刷新后可恢复会话继续追问（十几分钟的仪式流程不该因刷新作废）
              try { localStorage.setItem("tarot:sessionId", p.sessionId); } catch { /* 隐私模式 */ }
              break;
            case "phase":
              setPhase(p.phase ?? null);
              if (p.label) setPhaseLabel(p.label);              // 收束阶段：建"命运之卷"条目，后续收束 delta 流向它
              // （含 write_reading 综合正文与 close_reading 收束语）
              // P2-⑪：识别"限速等待"phase —— 让等待提示显示正确的原因
              if (p.label && p.label.includes("限流")) setRateLimited(true);
              /**
               * ⚠️ 2026-11-04 新增：阶段转换的"锣"音效
               * ⚠️ 目的：让用户感觉到"仪式在推进"（而不是"程序在等"）。
               * ⚠️ 只在**关键阶段**播（不是每个 phase 都播）——
               *    否则会变成噪音。关键节点 = 呼召 / 选牌 / 讲牌 / 综合 / 收束。
               */
              if (p.phase && STAGE_GONG_PHASES.includes(p.phase)) {
                void playSfx("gong");
              }
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
            case "nudge":
              // ⚠️ P1-⑧：HITL 等待中的分级提醒。
              //    渲染成一行低调小字（FlowEntryKind="nudge"）——
              //    刻意不用气泡：气泡会被当成"占卜师在说话"。
              //    同一条提醒只显示一次（level 1/2 各一条）。
              if (p.nudge) {
                setEntries((prev) => {
                  const dup = prev.some((e) => e.kind === "nudge" && e.text === p.nudge!.text);
                  if (dup) return prev;
                  const sid = nextEntryId();
                  return [...prev, { id: sid, kind: "nudge", text: p.nudge!.text } as FlowEntry];
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
              /**
               * ⚠️⚠️ 2026-11-04 新增：flip 事件**提前**把牌置为可点
               *
               * ⚠️ 用户实测报告："牌出现了，但有时候点的无效"。
               *   根因：后端的时序是
               *     await flipWait（闸门就绪）→ yield ask_user(flip) → yield card_flip_ready
               *   前端**只在 card_flip_ready 时**把该牌设为 current（可点）。
               *   两个事件之间有网络/调度间隙 → **牌已经显示，但点不动**。
               *   → 用户点了一下没反应 → 以为牌坏了。
               *
               *   修法：ask_user(kind=flip) 本身就意味着"现在该翻这张了"
               *        （后端是先建闸门、再发这个事件的，闸门此刻已就绪）
               *        → 在这里**提前**置 current，不等 card_flip_ready。
               *   ⚠️ card_flip_ready 事件仍保留（它是权威信号，会再置一次，幂等）。
               */
              if (p.ask?.kind === "flip") {
                setSpread((prev) => {
                  if (prev.length === 0) return prev;
                  // ⚠️ 找"第一张还没翻开的牌"（= 现在该翻的那张）
                  const target = prev.findIndex((c) => !c.flipped && !c.flipping);
                  if (target < 0) return prev;
                  return prev.map((c, i) => ({ ...c, current: i === target }));
                });
              }
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
                /**
                 * ⚠️⚠️ 2026-11-04 新增：把问题同步到**牌阵条目**
                 *
                 * ⚠️ 为什么必须同步：
                 *   SpreadPanel 的自动展开逻辑要判断"牌上是否还有待回答的问题"
                 *   （见 DialogueFlow 的 hasPendingCardQuestion）——
                 *   否则用户回答牌面问题时，牌阵是**收起**的 → 看不到问题
                 *   → 用户实测报告的"还要重新手动打开选择"。
                 *
                 * ⚠️ 同步到**哪一张**：刚翻开的那张（最后一张已翻开的牌）。
                 *   ⚠️ 不能用 "current"（card_reveal 已把它清空了）。
                 */
                const q = p.ask.question;
                setEntries((prev) => {
                  const lastFlipped = [...prev]
                    .reverse()
                    .find((e) => e.kind === "spread" && e.spread && e.spread.some((c) => c.flipped));
                  if (!lastFlipped?.spread) return prev;
                  return prev.map((e) =>
                    e.id === lastFlipped.id
                      ? {
                          ...e,
                          spread: e.spread!.map((c) => {
                            // ⚠️ 只给"最后一张已翻开的牌"挂问题（还没答的那张）
                            if (!c.flipped) return c;
                            const alreadyAnswered = !!c.answer;
                            return alreadyAnswered ? c : { ...c, question: q };
                          }),
                        }
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
                // ⚠️ 2026-11-04 新增：牌面揭示的"磬"音效
                // ⚠️ 这是整个仪式里**最重要的一下**（用户亲手翻开，牌面第一次显现）
                //    → 值得一个带长混响尾的磬声。
                void playSfx("reveal");
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
                      // ⚠️ flipping: false —— 乐观翻转动画在此**落定**
                      //   （点击时本地先转 90°，后端事件到了才补牌面）
                      ? { ...c, flipped: true, active: true, current: false, flipping: false, nameZh: r.nameZh, image: r.image, reversed: r.reversed }
                      : { ...c, active: false, current: false }
                  );
                  if (next.length === 0) {
                    // 首次收到：构造完整牌阵（当前牌 + 后续待翻）
                    return [{ ...r, index: r.cardIndex, done: false, active: true, flipped: true, current: false, flipping: false } as SpreadCard];
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
                  prev.map((c, i) =>
                    i === fr.cardIndex
                      ? { ...c, current: true, flipping: false }
                      : { ...c, current: false }
                  )
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

  /**
   * 断点续传（P1-③D）—— 让后端补发缺失的事件。
   *
   * ⚠️ 语义：只补发**已经产生过**的事件（后端缓冲区里）。
   *    后端 agent 若已跑完，补发后用户能看到完整对话；
   *    若还在跑，会话继续推进（用户可以继续回答 HITL）。
   *
   * @returns 是否成功恢复
   */
  const resumeStream = useCallback(async (): Promise<boolean> => {
    // ⚠️ P0-③：读 **ref** 而不是 state 闭包
    //    （startDivination 的 catch 块在同一调用栈内执行，
    //      state 闭包捕获的是启动时刻的值 = 空串 → 恢复分支永远进不去）
    const sid = sessionIdRef.current;
    if (!sid || lastSeqRef.current === 0) return false;
    try {
      // P0-③：恢复请求也走 AbortController（用户可能在恢复途中点「重新开始」）
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // SSE 标准头：告诉后端客户端最后收到哪个事件
          "Last-Event-ID": String(lastSeqRef.current),
        },
        body: JSON.stringify({ sessionId: sid, resume: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      await consumeStream(res);
      return true;
    } catch (e) {
      // ⚠️ 被主动取消 → 不是错误，不该弹"解读失败"
      if (e instanceof DOMException && e.name === "AbortError") return false;
      return false;
    } finally {
      streamAbortRef.current = null;
    }
  }, [consumeStream]);

  /**
   * 取消在途的 SSE 请求（P0-③）
   *
   * ⚠️ 必须在"重新开始 / 发起新请求 / 组件卸载"时调用：
   *   不取消的话，后端会继续跑完整场仪式（14 次 LLM 往返），
   *   白烧约 ¥0.22/次，而且后端还把它记成"正常完成"。
   */
  const abortStream = useCallback(() => {
    const ctrl = streamAbortRef.current;
    if (ctrl) {
      ctrl.abort();
      streamAbortRef.current = null;
    }
  }, []);

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
      //    （用户点「重新开始」时能真正中断，后端随之停止烧 token）
      abortStream();
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, persona: persona?.id, userKey: getUserKey(), mode }),
        signal: ctrl.signal,
      });
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
      streamAbortRef.current = null;
      setStreaming(false);
    }
  }, [question, persona, mode, consumeStream, streaming, resumeStream, abortStream]);

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
      // P0-③：追问同样要能被取消
      abortStream();
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, followup: f }),
        signal: ctrl.signal,
      });
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
        try { localStorage.removeItem("tarot:sessionId"); } catch { /* ignore */ }
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
      streamAbortRef.current = null;
      setStreaming(false);
    }
  }, [followup, sessionId, consumeStream, pushEntry, streaming, abortStream]);

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
    entryIdRef.current = 0;
    setError("");
    setStreaming(false);
  }, [abortStream]);

  const done = phase === "done" && !streaming;

  return (
    <main className="relative min-h-[100dvh] overflow-hidden flex flex-col items-center pt-12 md:pt-16 px-4">
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
        className="mt-3 text-lg md:text-xl text-purple-200/75 z-10 tracking-[0.18em]"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        倾听星辰的低语 · 窥探命运的轨迹
      </motion.p>

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
        style={{ height: "calc(min(20.3vw, 18.2vh) + 20vh)" }}
      />

      {/* ---------- 运势入口（2026-11-04 C 方向 · 2026-11-05 视觉重设计）----------
          ⚠️ 竞品对标：Tarot Run 的顶栏有「每日塔罗」，Tarotap 有 5 种运势。
          ⚠️ 为什么放在副标题下（而不是右上角）：
            右上是音乐按钮（固定不动），这里是**内容流**的一部分 ——
            用户刚进站、正准备提问，此时看到"今天也有牌"能降低"必须提问才能用"的门槛。
          ⚠️ 2026-11-05：从「文字胶囊」改成「图标卡片」——
            胶囊只有一行小字，在深色背景上几乎看不见（截图实测）；
            卡片有图标 + 标题 + 说明 → 既是入口，也是产品能力的展示。 */}
      {stage === "input" && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.6 }}
          className="w-full max-w-2xl z-10 -mt-2 mb-7"
        >
          {/**
           * ⚠️ 2026-11-06 对比度修正（用户反馈："背景是紫色的，上面图标文字模块又都是紫色的 对比度太差"）。
           *
           * ⚠️ 根因：**紫底 + 紫组件 + 紫文字** = 三者同色系 → 全部糊在一起。
           *   截图实测：入口卡片的 `bg-purple-950/25` 叠在紫背景上几乎看不出边界，
           *   文字 `text-purple-300/40` 更是有字形都看不清。
           *
           * ⚠️ 解法（颜色分工）：
           *   · **背景层**  保持紫色（深空氛围）
           *   · **容器层**  深色实底（近黑紫 rgba(9,5,20,.78)）+ 玻璃模糊 → 有明确边界
           *   · **描边层**  金色（rgba(212,175,55,.28)）→ 与紫底分离
           *   · **图标层**  金色实心圈 + 金色图标 → 视觉焦点
           *   · **文字层**  标题近白（琥珀白）、描述提亮到 68%
           *   → 一句话：**背景紫、容器深、描边金、图标金、文字白**。
           */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                href: "/daily",
                icon: "moon" as const,
                img: "/images/celestial/icon-daily.webp",
                title: "今日之牌",
                desc: "今天与你有关的那张牌",
              },
              {
                href: "/fortune",
                icon: "orbit" as const,
                img: "/images/celestial/icon-fortune.webp",
                title: "运势专区",
                desc: "每日 · 月 · 季 · 年运",
              },
              {
                href: "/oracle",
                icon: "crystal" as const,
                img: "/images/celestial/icon-oracle.webp",
                title: "问神谕",
                desc: "不必抽牌，也能问",
              },
            ].map((e) => (
              <Link
                key={e.href}
                href={e.href}
                className="group relative rounded-2xl border border-[rgba(212,175,55,0.26)] bg-[rgba(9,5,20,0.78)] backdrop-blur-md px-4 py-4 transition-all duration-300 hover:border-[rgba(240,217,138,0.55)] hover:-translate-y-1"
                style={{
                  boxShadow:
                    "0 8px 30px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07)",
                }}
              >
                {/* 悬停时的金色边光 */}
                <span
                  className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                  style={{
                    boxShadow: "0 0 30px rgba(212,175,55,0.32), inset 0 0 20px rgba(212,175,55,0.08)",
                  }}
                />
                <div className="flex items-start gap-3">
                  {/**
                   * ⚠️ 2026-11-06：图标改用 **AI 生成的金质纹样**（月+书 / 轨道 / 眼）。
                   *
                   * ⚠️⚠️ 为什么**去掉圆圈底**（用户反馈："图标外面还有白色的底色"）：
                   *   ① AI 出的图标**本身就是完整的圆形纹样**（月+书 / 星盘 / 眼）
                   *      → 再套一个圆圈 = 圆圈里挤一团金色 → 22px 下糊成一团，
                   *      边缘的半透明渐变看起来就像"有白底"。
                   *   ② 图标放大到 30px → 细节看得清。
                   *   → 去掉底圈，直接放图标 + 金色微光。
                   */}
                  <span className="w-8 h-8 shrink-0 flex items-center justify-center">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={e.img}
                      alt=""
                      className="w-[30px] h-[30px] object-contain"
                      style={{
                        filter:
                          "drop-shadow(0 0 6px rgba(240,217,138,0.55)) drop-shadow(0 0 14px rgba(212,175,55,0.25))",
                      }}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] tracking-[0.12em] text-[rgba(255,248,235,0.96)] group-hover:text-amber-50">
                      {e.title}
                    </span>
                    <span className="block text-[10px] text-[rgba(203,190,255,0.68)] mt-0.5 leading-snug">
                      {e.desc}
                    </span>
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </motion.div>
      )}

      {/* ---------- 输入阶段 ---------- */}
      {stage === "input" && (
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7 }}
          className="w-full max-w-xl z-10"
        >
          {/* ---------- 人格选择（2026-11-05 视觉重设计）----------
              ⚠️ 从「方块卡片」改成「圆形符文头像」：
                六个同样的方块摆在那儿 → 视觉权重相同、没有主次、没有"人"的感觉。
                圆形徽章是神秘学语境里最自然的载体，且天然有聚焦感。 */}
          <div className="mb-7">
            <p className="text-[11px] tracking-[0.28em] text-[rgba(212,175,55,0.72)] mb-4 text-center">
              选 择 你 的 占 卜 师
            </p>
            {/**
             * ⚠️ 2026-11-06：排列从 flex-wrap 改成 grid-cols-5。
             * ⚠️ 为什么：flex-wrap 下 5 个徽章是「4 + 1」——
             *   最后一个孤零零掉到第二行 → 视觉断裂（截图实测）。
             * → grid-cols-5 保证一行五个、间距均匀。
             *   移动端用 grid-cols-3（第二行两个居中）。
             */}
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-x-3 gap-y-5 justify-items-center max-w-[560px] mx-auto">
              {personas.map((p, pi) => (
                <PersonaOrb
                  key={p.id}
                  id={p.id}
                  name={p.name}
                  tagline={p.desc}
                  selected={persona?.id === p.id}
                  onClick={() => setPersona(p)}
                  index={pi}
                />
              ))}
            </div>
          </div>

          {/* ---------- 占卜模式切换（2026-11-04 双模式）----------
            ⚠️ 为什么放在输入框**上方**（而不是占卜开始后）：
              用户在**提问之前**就该知道这次会得到什么 ——
              "快速一问 vs 深度解读"是两种不同的**产品**，不是同一个东西的快慢版。
              放在后面就变成了"已经开始了才告诉我会等很久"（预期错配）。 */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-[11px] tracking-[0.2em] text-[rgba(212,175,55,0.62)]">占卜方式</span>
            {(Object.keys(MODE_PROFILES) as DivinationMode[]).map((m) => {
              const p = MODE_PROFILES[m];
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={active}
                  title={`${p.tagline} · 约 ${p.estSeconds[0]}~${p.estSeconds[1]} 秒`}
                  className={`px-3 py-1.5 rounded-full text-xs tracking-[0.15em] border transition-all ${
                    active
                      ? "border-purple-400/60 bg-purple-500/20 text-purple-100 shadow-[0_0_16px_rgba(168,85,247,0.28)]"
                      : "border-white/10 bg-white/[0.03] text-purple-300/50 hover:text-purple-200/80 hover:border-purple-400/30"
                  }`}
                >
                  {p.label}
                  <span className="ml-1.5 text-[10px] opacity-55">
                    {p.estSeconds[0]}~{p.estSeconds[1]}s
                  </span>
                </button>
              );
            })}
            <span className="text-[10px] text-[rgba(196,181,253,0.55)] ml-1">
              {MODE_PROFILES[mode].tagline}
            </span>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              {/**
               * ⚠️ 2026-11-06 对比度修正：
               *   原来 `bg-purple-950/30` + `border-purple-500/30` 叠在紫背景上 → 输入框边界不清。
               * → 改为**深色实底 + 金色描边**，聚焦时金色发光（与魔法阵呼应）。
               */}
              <input
                className="w-full px-5 py-4 pr-12 text-lg rounded-2xl bg-[rgba(9,5,20,0.82)] backdrop-blur-md border border-[rgba(212,175,55,0.32)] text-[rgba(255,250,240,0.96)] placeholder-[rgba(190,178,235,0.42)] focus:outline-none focus:border-[rgba(240,217,138,0.75)] focus:shadow-[0_0_30px_rgba(212,175,55,0.30)] transition-all"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                placeholder="在此写下你的困惑…"
                // ⚠️ P2-⑮：placeholder 不是可访问名称 —— 屏幕阅读器读不到。
                //   加 aria-label 让输入框有真正的名字。
                aria-label="写下你的问题"
                value={question}
                onChange={(e) => { setQuestion(e.target.value); setError(""); }}
                onKeyDown={(e) => e.key === "Enter" && startDivination()}
                maxLength={100}
              />
              <button
                onClick={startVoice}
                title="语音输入"
                className={`absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                  listening ? "bg-rose-500/30 text-rose-300 animate-pulse" : "text-[rgba(203,190,255,0.75)] hover:text-amber-200"
                }`}
              >
                {listening ? (
                  <span className="w-2.5 h-2.5 rounded-full bg-current animate-pulse" />
                ) : (
                  <Icon name="thought" size={15} />
                )}
              </button>
            </div>
            <motion.button
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
              onClick={startDivination}
              /**
               * ⚠️ 2026-11-10：改成「用户抠好的金丝羽叶边框图」。
               *
               * ⚠️ 用户要求（三条）：
               *   ① 「不要加 border 了 只用图片」→ 去掉 CSS border，框线全部由图提供
               *   ② 「内部文字用深色的颜色」→ 图中间是**羊皮纸米色底** → 文字必须深色才看得清
               *   ③ 「hover 上去的时候加特效」→ hover 时发光 + 提亮
               *
               * ⚠️ 为什么容器是 142×80 而不是 128×62：
               *   图里框的外面还有一圈透明区（用户抠图时保留了）
               *   → 用 object-contain 按原比例贴进容器 → **零变形**
               *   → 容器高 80px 时，视觉框正好 = 80 × (555/720) = **62px**（= 输入框高）
               *   → 容器宽 142px 时，视觉框宽 = 142 × (1154/1280) = **128px**
               */
              className="group relative shrink-0 w-[142px] h-20"
            >
              {/* 边框图（object-contain → 按原比例，不裁不拉伸） */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/celestial/btn-start.png"
                alt=""
                className="absolute inset-0 w-full h-full object-contain pointer-events-none
                  transition-all duration-300
                  group-hover:brightness-110 group-hover:drop-shadow-[0_0_14px_rgba(240,205,120,0.55)]"
              />
              {/* hover 时的底部辉光（额外一层，让"发光"更有层次） */}
              <span
                className="absolute inset-0 pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  background:
                    "radial-gradient(ellipse 60% 100% at 50% 100%, rgba(240,205,120,0.22), transparent 70%)",
                  filter: "blur(6px)",
                }}
              />
              {/* 文字（深色 —— 因为图中间是米色羊皮纸底） */}
              <span
                className="relative text-[#4a3312] text-lg font-semibold tracking-[0.14em]"
                style={{
                  fontFamily: "'Ma Shan Zheng', serif",
                  textShadow: "0 1px 0 rgba(255,240,200,0.55)",
                }}
              >
                开始占卜
              </span>
            </motion.button>
          </div>
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
          {/* ---------- 牌阵横条（固定顶部，进度可见；与对话流牌阵同一份状态）---------- */}
          {spread.length > 0 && (
            <CardSpread cards={spread} onFlipCard={flipCard} onPreview={openCardPreview} />
          )}

          {/* ---------- Agent 状态条 ---------- */}
          {(phase || streaming) && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
              <AgentStatusBar phase={phase} />
              {phaseLabel && <p className="mt-2 text-center text-xs text-purple-400/60 tracking-wide">{phaseLabel}</p>}
              {streaming && !ask && <WaitingHint since={streamStart} rateLimited={rateLimited} />}
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
