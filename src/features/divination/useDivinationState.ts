"use client";

import { useMemo, useState } from "react";

import { DEFAULT_MODE, type DivinationMode } from "@/lib/agent/divination-mode";

import type {
  FanCard,
  FlowEntry,
  PersonaView,
  Phase,
  PreviewCard,
  RagHitView,
  ReviewData,
  RoundInfo,
  SpreadCard,
  Stage,
  SubAgentEvent,
  ToolCall,
} from "./types";

/**
 * useDivinationState —— 占卜页面的全部状态（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️⚠️ 设计目标：**page.tsx 的 250 处 setter 调用点一行都不用改**
 *
 * ⚠️ 为什么对外暴露的 setter 用法与 useState 完全一致：
 *   · 传值：setError("出错了")
 *   · 函数式更新：setEntries(prev => [...prev, item])
 *   → 搬运时零语义变化 → 零回归风险 ✅
 *
 * ⚠️⚠️⚠️ 为什么**内部还是 useState**（而不是 useReducer）：
 *   · 我第一版用 useReducer 实现 → eslint 报 30 个
 *     `react-hooks/exhaustive-deps` 警告（实测）
 *   · 原因：eslint 的规则**认识** useState 的 setter 是稳定的，
 *     但**不认识**自定义 hook 返回的 setter → 认为它每次渲染都变
 *     → page.tsx 里 24 个 useCallback 的依赖数组检查全挂 ⚠️
 *   → 改回 useState：
 *     · eslint 能正确识别 → 警告消失 ✅
 *     · 34 个 useState 依然集中在这个文件里（page.tsx 看不到）✅
 *     · 失去 batch 能力（SSE 一帧更新多个字段时多几次调度）
 *       → 但 React 18+ 会自动批处理同一次事件里的多个 setState
 *       → 实际影响可忽略 ✅
 *   → 结论：**集中管理**才是目的，reducer 不是必需 ✅
 */

/* ---------------- 状态形状 ---------------- */

export interface AskPayload {
  question: string;
  options?: string[];
  cardSelection?: boolean;
  crossroads?: boolean;
  /** HITL 类型，决定用哪个面板渲染 */
  kind?: string;
}

export interface PersonaSuggest {
  personaId: string;
  name: string;
  emoji: string;
  reason: string;
}

/* ---------------- 对外的 setter 类型 ---------------- */

/**
 * ⚠️ setter 签名与 React 的 `Dispatch<SetStateAction<T>>` **完全一致**
 * → 传值或传 updater 都可以 → page.tsx 的调用点零改动
 */
export type Setter<T> = (value: T | ((prev: T) => T)) => void;

export interface DivinationStateApi {
  question: string;
  persona: PersonaView | null;
  mode: DivinationMode;
  personas: PersonaView[];
  stage: Stage;
  sessionId: string;
  phase: Phase | null;
  phaseLabel: string;
  rateLimited: boolean;
  reading: string;
  reasoning: string;
  tools: ToolCall[];
  rounds: RoundInfo[];
  ragHits: RagHitView[];
  ask: AskPayload | null;
  fanCards: FanCard[];
  fanCount: number;
  followup: string;
  subagentEvents: SubAgentEvent[];
  review: ReviewData | null;
  planSteps: string[];
  personaSuggest: PersonaSuggest | null;
  canFollowup: boolean;
  streaming: boolean;
  error: string;
  hint: string;
  listening: boolean;
  streamStart: number;
  thinkingElapsed: number;
  showDetails: boolean;
  spread: SpreadCard[];
  previewCard: PreviewCard | null;
  interject: string;
  entries: FlowEntry[];

  setQuestion: Setter<string>;
  setPersona: Setter<PersonaView | null>;
  setMode: Setter<DivinationMode>;
  setPersonas: Setter<PersonaView[]>;
  setStage: Setter<Stage>;
  setSessionId: Setter<string>;
  setPhase: Setter<Phase | null>;
  setPhaseLabel: Setter<string>;
  setRateLimited: Setter<boolean>;
  setReading: Setter<string>;
  setReasoning: Setter<string>;
  setTools: Setter<ToolCall[]>;
  setRounds: Setter<RoundInfo[]>;
  setRagHits: Setter<RagHitView[]>;
  setAsk: Setter<AskPayload | null>;
  setFanCards: Setter<FanCard[]>;
  setFanCount: Setter<number>;
  setFollowup: Setter<string>;
  setSubagentEvents: Setter<SubAgentEvent[]>;
  setReview: Setter<ReviewData | null>;
  setPlanSteps: Setter<string[]>;
  setPersonaSuggest: Setter<PersonaSuggest | null>;
  setCanFollowup: Setter<boolean>;
  setStreaming: Setter<boolean>;
  setError: Setter<string>;
  setHint: Setter<string>;
  setListening: Setter<boolean>;
  setStreamStart: Setter<number>;
  setThinkingElapsed: Setter<number>;
  setShowDetails: Setter<boolean>;
  setSpread: Setter<SpreadCard[]>;
  setPreviewCard: Setter<PreviewCard | null>;
  setInterject: Setter<string>;
  setEntries: Setter<FlowEntry[]>;
}

/**
 * ⚠️⚠️ 为什么用 `useState` 而不是 `useReducer`：
 *   · eslint 的 `react-hooks/exhaustive-deps` **认识** useState 的 setter 是稳定的
 *   · 但**不认识**自定义 hook 返回的 setter → 误判为不稳定
 *     → page.tsx 的 useCallback 依赖数组检查全挂（实测 30 个警告）❌
 *   → useState 版本：警告消失，且状态依然集中管理 ✅
 */
export function useDivinationState(): DivinationStateApi {
  const [question, setQuestion] = useState("");
  const [persona, setPersona] = useState<PersonaView | null>(null);
  const [mode, setMode] = useState<DivinationMode>(DEFAULT_MODE);
  const [personas, setPersonas] = useState<PersonaView[]>([]);
  const [stage, setStage] = useState<Stage>("input");
  const [sessionId, setSessionId] = useState("");
  const [phase, setPhase] = useState<Phase | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [rateLimited, setRateLimited] = useState(false);
  const [reading, setReading] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [tools, setTools] = useState<ToolCall[]>([]);
  const [rounds, setRounds] = useState<RoundInfo[]>([]);
  const [ragHits, setRagHits] = useState<RagHitView[]>([]);
  const [ask, setAsk] = useState<AskPayload | null>(null);
  const [fanCards, setFanCards] = useState<FanCard[]>([]);
  const [fanCount, setFanCount] = useState(3);
  const [followup, setFollowup] = useState("");
  const [subagentEvents, setSubagentEvents] = useState<SubAgentEvent[]>([]);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [planSteps, setPlanSteps] = useState<string[]>([]);
  const [personaSuggest, setPersonaSuggest] =
    useState<PersonaSuggest | null>(null);
  const [canFollowup, setCanFollowup] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [listening, setListening] = useState(false);
  const [streamStart, setStreamStart] = useState(0);
  const [thinkingElapsed, setThinkingElapsed] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [spread, setSpread] = useState<SpreadCard[]>([]);
  const [previewCard, setPreviewCard] = useState<PreviewCard | null>(null);
  const [interject, setInterject] = useState("");
  const [entries, setEntries] = useState<FlowEntry[]>([]);

  /**
   * ⚠️ 返回值用 useMemo 包装
   * ⚠️ 为什么需要：整个对象每次渲染都是新的 → 消费方放进依赖数组就失效
   * → useMemo 让它只在 state 变化时重建 ✅
   */
  return useMemo(
    () => ({
      question,
      setQuestion,
      persona,
      setPersona,
      mode,
      setMode,
      personas,
      setPersonas,
      stage,
      setStage,
      sessionId,
      setSessionId,
      phase,
      setPhase,
      phaseLabel,
      setPhaseLabel,
      rateLimited,
      setRateLimited,
      reading,
      setReading,
      reasoning,
      setReasoning,
      tools,
      setTools,
      rounds,
      setRounds,
      ragHits,
      setRagHits,
      ask,
      setAsk,
      fanCards,
      setFanCards,
      fanCount,
      setFanCount,
      followup,
      setFollowup,
      subagentEvents,
      setSubagentEvents,
      review,
      setReview,
      planSteps,
      setPlanSteps,
      personaSuggest,
      setPersonaSuggest,
      canFollowup,
      setCanFollowup,
      streaming,
      setStreaming,
      error,
      setError,
      hint,
      setHint,
      listening,
      setListening,
      streamStart,
      setStreamStart,
      thinkingElapsed,
      setThinkingElapsed,
      showDetails,
      setShowDetails,
      spread,
      setSpread,
      previewCard,
      setPreviewCard,
      interject,
      setInterject,
      entries,
      setEntries,
    }),
    [
      question, persona, mode, personas, stage, sessionId, phase, phaseLabel,
      rateLimited, reading, reasoning, tools, rounds, ragHits, ask, fanCards,
      fanCount, followup, subagentEvents, review, planSteps, personaSuggest,
      canFollowup, streaming, error, hint, listening, streamStart,
      thinkingElapsed, showDetails, spread, previewCard, interject, entries,
    ]
  );
}
