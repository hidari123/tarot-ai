/**
 * Agent 核心类型 —— 所有 agent 子模块的共享契约
 *
 * 拆包说明（2026-10 重构）：
 *   原 src/lib/tarot-agent.ts 2590 行混合了 5 种职责（会话生命周期 / HITL 等待 /
 *   LLM 调用 / 工具执行 / Supervisor 主循环），无法单测、无法并行演进。
 *   本文件是拆包后的**类型单一事实源** —— 所有子模块都从这里取类型，
 *   不各自定义（避免同名不同形的隐式不一致）。
 *
 * 对外 API 保持不变：src/lib/agent/index.ts 统一 re-export，
 * 现有 `import { runAgent } from "@/lib/tarot-agent"` 的调用方零改动。
 */

import type { TarotCard } from "../tarot-cards";
import type { RagHit } from "../rag-engine";
import type { Persona } from "../personas";

export type { TarotCard, RagHit, Persona };

/* ------------------------------------------------------------------ */
/* HITL                                                                */
/* ------------------------------------------------------------------ */

/**
 * HITL（Human-in-the-Loop）提问类型 —— 决定前端渲染形态与回答解析方式。
 *
 * ⚠️ "flip"（翻牌闸门）是逐张手动翻牌改造新增的：
 *    阻塞点是**唯一**的（reveal_card 里 await），
 *    其余环节只发 phase 事件不阻塞 —— 否则会留下"悬空 ask"
 *    （前端渲染了面板但后端没在等 → 用户点它必然 409）。
 */
export type AskKind =
  | "clarify"        // 澄清
  | "contract"      // 承约（复述问题请用户确认）
  | "invocation"    // 呼召（三问）
  | "card_confirm"  // 牌面确认（翻牌后问用户感受）
  | "closing"       // 收束追问
  | "crossroads"    // 岔路口
  | "flip";         // 翻牌闸门（点牌即翻，无按钮）

/* ------------------------------------------------------------------ */
/* SSE 事件                                                            */
/* ------------------------------------------------------------------ */

/**
 * Agent → 前端的 SSE 事件（20+ 种）。
 *
 * ⚠️ 防剧透边界（已与需求方确认）：
 *   保护的是**牌面视觉** —— 未翻开的牌，牌名/图片/牌意都不下发。
 *   - cards 事件只含位置（id/nameZh/image 为空占位）
 *   - card_flip_ready 刻意不含牌面
 *   - card_reveal 才下发牌名 + 图片
 *   模型自己生成的正文里出现牌名**不拦截**（解读本来就要说出牌名）。
 */
export interface AgentEvent {
  type:
    | "session" | "phase" | "reasoning" | "tool" | "rag_hits"
    | "cards" | "ask_user" | "subagent" | "review" | "delta"
    | "card_reveal" | "card_reading" | "card_flip_ready"
    | "contract" | "invocation" | "round" | "plan"
    | "persona_suggest" | "done" | "error";

  /** ① 会话建立 */
  sessionId?: string;
  /** ② 阶段切换（前端状态条） */
  phase?: "analyze" | "retrieve" | "draw" | "interpret" | "wait_user" | "review" | "done" | "error";
  label?: string;
  /** ③ 思考链 */
  reasoning?: string;
  /** ④ 工具调用流水 */
  tool?: {
    name: string;
    args: unknown;
    resultSummary?: string;
    durationMs?: number;
  };
  /** ⑤ RAG 检索命中 */
  ragHits?: RagHit[];
  /** ⑥ 牌阵（⚠️ 防剧透：只含位置，牌面等 card_reveal 才下发） */
  cards?: Array<{
    id: string;
    nameZh: string;
    image: string;
    reversed: boolean;
    pos: string;
  }>;
  /** ⑦ HITL 提问 */
  ask?: {
    question: string;
    options?: string[];
    allowFree?: boolean;
    prompt?: string;
    kind?: AskKind;
  };
  cardSelection?: boolean;
  crossroads?: boolean;
  /** 选牌扇面（7 张随机牌） */
  fanCards?: TarotCard[];
  fanCount?: number;
  /** ⑧ 子 Agent 事件 */
  subagent?: {
    agent: string;
    action: string;
    detail?: string;
  };
  /** ⑨ 审校结果 */
  review?: {
    pass: boolean;
    scores: { grounding: number; empathy: number; tone: number };
    comment?: string;
    revision?: string;
  };
  /** ⑩ 流式正文（⚠️ 唯一正文通道，避免多数据源竞争） */
  delta?: string;
  /** ⑪ 牌面下发（牌面视觉防剧透的放行点） */
  cardReveal?: {
    cardIndex: number;
    total: number;
    id: string;
    nameZh: string;
    image: string;
    reversed: boolean;
    pos: string;
    narrative: string;
    meaning: string;
  };
  /** ⑫ 某张牌解读完成（⚠️ 不带 text —— 正文只由 delta 给出，杜绝双写重复） */
  cardReading?: { cardIndex: number };
  /** ⑬ 第 N 张可以翻了（⚠️ 刻意不含牌面） */
  cardFlipReady?: { cardIndex: number; total: number; pos: string };
  /** ⑭ 承约 */
  contract?: { question: string; scope?: string };
  /** ⑮ 呼召 */
  invocation?: { questions: string[] };
  /** ⑯ 轮次信息 */
  round?: { round: number; elapsedMs: number; promptTokens?: number; toolNames: string[]; phase?: string };
  /** ⑰ Plan-Execute 计划 */
  plan?: string[];
  /** ⑱ 人格建议（情绪驱动） */
  personaSuggest?: { personaId: string; name: string; emoji: string; reason: string };
  /** ⑲ 完成 */
  done?: boolean;
  /** ⑳ 错误 */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export interface DrawnCard {
  card: TarotCard;
  reversed: boolean;
}

/** 消息角色 —— OpenAI 兼容协议 */
export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}

/**
 * 一次占卜会话的全部状态。
 *
 * ⚠️ 状态分层：
 *   - 内存（Map）：热状态，进程内，30min TTL
 *   - SQLite：持久化（历史/dashboard/画像）
 *   拆包后 session.ts 负责内存态，agent/state.ts（后续）负责持久化快照。
 */
export interface AgentSession {
  id: string;
  createdAt: number;
  lastActive: number;
  messages: SessionMessage[];
  question: string;
  persona: Persona;
  drawnCards: DrawnCard[];
  ragHits: RagHit[];
  analystNotes: string;
  /** 当前挂起的 HITL 等待（⚠️ 同一时刻只能有一个） */
  pendingAsk?: {
    resolve: (answer: string) => void;
    question: string;
    options?: string[];
    /** HITL 类型（决定前端渲染形态与回答解析方式） */
    kind?: AskKind;
  };
  /**
   * 客户端断开信号（由 API 路由注入）。
   * ⚠️ HITL 等待必须随它取消 —— 否则客户端断开后生成器
   *    永久挂在 Promise 上，start() 闭包与 session 一起泄漏。
   */
  abortSignal?: AbortSignal;
  finished: boolean;
  toolSeq: number;
  /**
   * 会话是否正在推进（生成器运行中 / 挂在 HITL 等待）。
   * ⚠️ 并发互斥用：会话推进中时新的 interpret 会把消息插到
   *    未配对的 tool_calls 后 → 协议 400 + 历史交叉污染。
   */
  busy?: boolean;
  /**
   * 最终解读正文（完整文本）—— 与 cardReadings 的分段不同，
   * 这里是一整篇（落库/分享卡用）。
   */
  reading?: string;
  /** 已执行过的 rag_search 查询（归一化后），用于重复检索负反馈（防死循环） */
  ragQueryHistory: string[];
  /** 检索调用次数（预算控制：超过 RAG_BUDGET 后注入"立即收尾"提示） */
  ragCallCount: number;
  /** 每张牌的选牌犹豫时长 ms（offer_card_selection 采集；-1 表示随机代抽） */
  dwellTimes: number[];
  /** 情绪档案：从用户澄清回答中提取的情绪关键词 */
  emotionTags: string[];
  /** A1：承约——占卜师复述确认后的具体问题 */
  contractQuestion?: string;
  /** A2：牌阵范围声明 */
  scopeNote?: string;
  /** A3：三问呼召 —— 问题 + 用户回答 */
  invocationAnswers?: string[];
  /** A3：三问呼召 —— 问题与回答的配对（q/a 结构） */
  invocation?: { questions: string[]; answers: string[] };
  /** 插话（用户中途补充的信息） */
  interjections: string[];
  /** 不安全位置暂存的插话（等下一轮开头 flush） */
  pendingInterjections: string[];
  /** 跨会话画像 key */
  userKey?: string;
  /** 已完成的牌解读（按"首次触牌顺序"append ⚠️ 不能按下标对 drawnCards） */
  cardReadings: Array<{
    cardId: string;
    nameZh?: string;
    pos?: string;
    reveal?: { narrative: string; meaning: string; question: string; options?: string[] };
    answer?: string;
    reading?: string;
    /** 该牌已翻开（逐张翻牌闸门的状态） */
    flipped?: boolean;
  }>;
  /** Plan-Execute 模式下 supervisor 先行的执行计划 */
  plan?: string[];
  /** 模式来源（plan=Plan-Execute / react=默认 ReAct），落库便于效果对比 */
  agentMode?: "plan" | "react";
  /**
   * 是否由快照恢复而来（进程重启后）。
   * ⚠️ 恢复的会话**没有 pendingAsk**（Promise 不可序列化）——
   *    前端/接口需要据此给出明确文案（"等待状态无法恢复"），
   *    而不是笼统的"会话已过期"。
   */
  restoredFromSnapshot?: boolean;
  /** 已被用户亲手翻开的牌索引（按翻开顺序） */
  flippedCardIdx?: number[];
}

/* ------------------------------------------------------------------ */
/* 子 Agent 类型                                                       */
/* ------------------------------------------------------------------ */

export type SubAgent = "supervisor" | "analyst" | "writer" | "reviewer";
