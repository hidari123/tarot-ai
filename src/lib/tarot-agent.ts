/**
 * 塔罗多 Agent 引擎 —— supervisor 编排 + 子 Agent 分工 + Reflexion 反思重写
 *
 * 架构（面试可讲）：
 *
 *   ┌────────────── Supervisor（占卜师编排者，工具调用循环）──────────────┐
 *   │  决策：何时澄清(ask_user) / 抽牌(draw_cards) / 检索(rag_search)      │
 *   │        何时交给子 Agent 管线 / 是否采纳审校意见                      │
 *   └────────────────────────────┬───────────────────────────────────────┘
 *                                │ 子 Agent 管线（fixed pipeline）
 *   ┌────────────────────────────▼───────────────────────────────────────┐
 *   │  ① 🔍 牌意分析师 (analyst)                                          │
 *   │     逐牌产出结构化分析笔记（元素/牌意引用/位置含义/与问题的关联）      │
 *   │  ② ✍️ 撰写者 (writer)                                               │
 *   │     基于分析笔记 + 用户上下文撰写解读（流式输出给用户）               │
 *   │  ③ 🧐 审校者 (reviewer) — Reflexion                                 │
 *   │     三维度打分（典籍忠实 grounding / 共情 empathy / 语气 tone, 0~10）│
 *   │     任一维度 < 7 → 生成修改指令打回撰写者重写（最多 1 次）            │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * HITL：ask_user / offer_card_selection / fate_crossroads 仍是 supervisor 工具，
 *       SSE 流挂起等待 /api/answer 唤醒。
 *
 * 会话：内存 Map（globalThis 单例）+ SQLite 持久化（历史/dashboard）。
 */

import { TAROT_CARDS, getCardById, type TarotCard } from "./tarot-cards";
import { hybridSearch, buildCardKnowledge, type RagHit } from "./rag-engine";
import {
  parseLLMJSON, extractScore, extractString,
} from "./robust-json";
import {
  buildSupervisorPrompt, buildAnalystPrompt, buildWriterPrompt, buildReviewerPrompt,
  buildFollowupPrompt, PROMPT_VERSION,
} from "./prompts";
import * as db from "./db";

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

export interface DrawnCard {
  card: TarotCard;
  reversed: boolean;
}

export type AgentPhase =
  | "analyze" | "retrieve" | "draw" | "interpret" | "wait_user" | "review" | "done" | "error";

export type SubAgent = "supervisor" | "analyst" | "writer" | "reviewer";

export interface Persona {
  id: string;
  name: string;
  emoji: string;
  desc: string;
  stylePrompt: string;
}

export const PERSONAS: Persona[] = [
  {
    id: "mystic",
    name: "月影占卜师",
    emoji: "🌙",
    desc: "神秘优雅 · 繁复优美的古典占卜师低语",
    stylePrompt:
      "你是\"月影占卜师\"，一位精通韦特塔罗的神秘学智者。语言繁复优美，兼具神秘感与温度，像一位真正的占卜师在低语。适度使用 ◈ ✦ 等符号。\n" +
      "【说话习惯】常用\"牌面告诉我…\"\"这副牌说…\"\"星辰早已写好…\"这类意象；念牌时先描述画面，再落到牌意；\n" +
      "问句偏含蓄诗意（\"你在这张牌前停留很久…\"），偶尔用\"孩子\"\"旅人\"称呼对方。",
  },
  {
    id: "healer",
    name: "心灵疗愈师",
    emoji: "🌿",
    desc: "温柔共情 · 偏心理疏导的疗愈系解读",
    stylePrompt:
      "你是\"心灵疗愈师\"，将塔罗作为自我觉察的镜子。语言温柔、共情、不带评判，注重情绪命名与接纳，像一位陪伴者。少用神秘符号，多用心理论述。\n" +
      "【说话习惯】先接住情绪再谈牌（\"听起来这段时间你挺不容易的…\"）；\n" +
      "用\"我听见你说…\"\"这或许说明了…\"\"如果允许自己…\"这类陪伴式句式；提问偏温和且留有余地。",
  },
  {
    id: "blade",
    name: "直断导师",
    emoji: "⚔️",
    desc: "犀利直接 · 不绕弯子的毒舌直断",
    stylePrompt:
      "你是\"直断导师\"，言辞犀利、一针见血，绝不绕弯子安慰。直面问题核心，甚至带点毒舌，但每句话都有塔罗依据。用户要的是真相而非安慰剂。\n" +
      "【说话习惯】不铺垫、不客套，开口就是判断（\"这牌没在骗你…\"\"别自欺了…\"）；\n" +
      "短句为主，敢下结论；提问带挑战性（\"你确定要继续这么耗下去？\"）。",
  },
];

export interface AgentEvent {
  type:
    | "session" | "phase" | "delta" | "reasoning" | "tool" | "rag_hits" | "cards"
    | "ask_user" | "subagent" | "review" | "round" | "done" | "error"
    /* ---- 真实塔罗流程新增事件 ---- */
    | "contract"        // A1：问题重述确认（承约）
    | "invocation"      // A3：三问呼召
    | "card_reveal"     // B：翻牌（牌面叙述 + 牌意）
    | "card_reading"    // B：该牌的完整解读段落
    | "closing";        // D：收束追问
  sessionId?: string;
  phase?: AgentPhase;
  label?: string;
  delta?: string;
  reasoning?: string;
  tool?: {
    name: string;
    args: Record<string, unknown>;
    resultSummary: string;
    durationMs: number;
  };
  ragHits?: RagHit[];
  cards?: { id: string; nameZh: string; image: string; reversed: boolean; pos: string }[];
  /** offer_card_selection：候选牌扇面（随机 7 张，供用户直觉挑选） */
  fanCards?: { id: string; nameZh: string; image: string }[];
  /** offer_card_selection：应选张数 */
  fanCount?: number;
  /** A2：牌阵范围声明（今天看什么） */
  scopeNote?: string;
  ask?: { question: string; options?: string[]; allowFree: boolean; prompt: string; kind?: AskKind };
  /** A3：三问呼召的三个问题 */
  invocation?: { questions: string[] };
  /** A1：占卜师复述的具体问题 */
  contract?: { question: string; scope?: string };
  /** B：翻牌信息 */
  cardReveal?: {
    cardIndex: number;
    total: number;
    id: string;
    nameZh: string;
    image: string;
    reversed: boolean;
    pos: string;
    /** 牌面叙述（客观描述画面） */
    narrative: string;
    /** 典籍牌意 */
    meaning: string;
    /** 引用来源 */
    source?: string;
  };
  /** B：该牌解读段落 */
  cardReading?: { cardIndex: number; text: string };
  subagent?: { agent: SubAgent; action: string; detail?: string }; // 子 Agent 生命周期
  review?: { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string; rewritten?: boolean; parseLevel?: 0 | 1 | 2 | 3; retried?: boolean };
  /** 轮次时间轴：每轮耗时与 token，供前端可视化"Agent 在哪一步慢" */
  round?: { round: number; elapsedMs: number; promptTokens?: number; toolNames: string[]; phase?: string };
  error?: string;
}

/**
 * HITL 交互类型（决定前端渲染成哪种面板 + 后端如何处理回答）
 * - clarify      普通澄清提问
 * - contract     A1 问题重述确认（承约）
 * - invocation   A3 三问呼召
 * - card_confirm B 逐张解读的确认问题
 * - closing      D 收束追问
 * - crossroads   命运岔路
 */
export type AskKind = "clarify" | "contract" | "invocation" | "card_confirm" | "closing" | "crossroads" | "continue";

/* ------------------------------------------------------------------ */
/* 会话存储（globalThis 单例 + SQLite 持久化）                          */
/* ------------------------------------------------------------------ */

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
  pendingAsk?: {
    resolve: (answer: string) => void;
    question: string;
    options?: string[];
    /** HITL 类型（决定前端渲染形态与回答解析方式） */
    kind?: AskKind;
  };
  finished: boolean;
  toolSeq: number;
  /** 已执行过的 rag_search 查询（归一化后），用于重复检索负反馈（防死循环） */
  ragQueryHistory: string[];
  /** 检索调用次数（预算控制：超过 RAG_BUDGET 后注入"立即收尾"提示） */
  ragCallCount: number;
  /** 每张牌的选牌犹豫时长 ms（offer_card_selection 采集；-1 表示随机代抽） */
  dwellTimes: number[];
  /** 情绪档案：从用户澄清回答中提取的情绪关键词（紧张/迷茫/期待…），供解读与追问持续引用 */
  emotionTags: string[];
  /** A1：承约——占卜师复述确认后的具体问题 */
  contractQuestion?: string;
  /** A2：牌阵范围声明 */
  scopeNote?: string;
  /** A3：三问呼召 —— 问题 + 用户回答 */
  invocation?: { questions: string[]; answers: string[] };
  /** B：逐张解读 —— 每张牌的解读段落与用户的确认回答 */
  cardReadings: Array<{
    cardId: string;
    nameZh: string;
    pos: string;
    /** 占卜师念牌（牌面叙述 + 牌意 + 确认问题） */
    reveal?: { narrative: string; meaning: string; question: string; options?: string[] };
    /** 用户对确认问题的回答 */
    answer?: string;
    /** 结合回答后的完整解读 */
    reading?: string;
  }>;
  /** C：用户在牌与牌之间的插话（补充/修正信息） */
  interjections: string[];
  /** 待插入的插话（位置不安全时暂存，下一轮开始时插入） */
  pendingInterjections: string[];
  /** 最终正文（旧管线由 writer 写入；逐张模式由 buildFinalReading 汇总） */
  reading?: string;
}

const sessions: Map<string, AgentSession> = (() => {
  const g = globalThis as unknown as { __tarotSessions__?: Map<string, AgentSession> };
  if (!g.__tarotSessions__) g.__tarotSessions__ = new Map();
  return g.__tarotSessions__;
})();
const SESSION_TTL = 30 * 60 * 1000;

/**
 * 启动对账（只执行一次）
 *
 * 进程重启会让内存会话全部丢失，但 SQLite 里这些会话还停在 running。
 * 启动时把"创建于 30 分钟前且仍是 running"的标记为 error（stale_timeout），
 * 避免 dashboard 出现永远运行中的僵尸数据。
 */
(() => {
  const g = globalThis as unknown as { __tarotReconciled__?: boolean };
  if (g.__tarotReconciled__) return;
  g.__tarotReconciled__ = true;
  try {
    const n = db.reconcileStaleSessions(30 * 60 * 1000);
    if (n > 0) console.error(`[session-reconcile] 清理 ${n} 个僵死会话（进程重启遗留）`);
  } catch (e) {
    console.error("[session-reconcile] 失败:", e instanceof Error ? e.message : e);
  }
  // 启动探测 provider：把不可用的直接标记失败，避免首个请求吃 20~80s 连接超时
  void probeProviders().catch(() => { /* 探测失败不影响启动 */ });
})();

function cleanExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) sessions.delete(id);
  }
}

export function createSession(question: string, personaId?: string): AgentSession {
  cleanExpired();
  const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const persona = PERSONAS.find((p) => p.id === personaId) ?? PERSONAS[0];
  const session: AgentSession = {
    id, createdAt: Date.now(), lastActive: Date.now(),
    messages: [], question, persona,
    drawnCards: [], ragHits: [], analystNotes: "",
    finished: false, toolSeq: 0,
    ragQueryHistory: [], ragCallCount: 0, dwellTimes: [], emotionTags: [],
    cardReadings: [], interjections: [], pendingInterjections: [],
  };
  sessions.set(id, session);
  db.insertSession(id, question, persona.id, []);
  return session;
}

export function getSession(id: string): AgentSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastActive = Date.now();
  return s;
}

export function resolvePendingAsk(sessionId: string, answer: string): boolean {
  const s = sessions.get(sessionId);
  if (!s?.pendingAsk) return false;
  s.pendingAsk.resolve(answer);
  s.pendingAsk = undefined;
  return true;
}

/**
 * 追加用户插话（方案 C）。
 *
 * 与 resolvePendingAsk 的区别：
 *   - resolvePendingAsk：回答**当前正在等**的问题（唤醒挂起的 Promise）
 *   - appendInterjection：用户主动补充信息，**不唤醒**任何等待，
 *     只把内容追加进会话历史，让接下来的解读能看到。
 *
 * 真实场景：用户在看第 1 张牌的解读时插一句"其实我不是不甘心，是怕又白投"，
 * 占卜师在讲第 2 张牌时就能用上这条信息。
 */
export function appendInterjection(sessionId: string, text: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  const t = text.trim();
  if (!t) return false;
  s.interjections.push(t);
  // ⚠️ 插话位置很关键：assistant 消息里的 tool_calls 必须紧跟对应的 tool 消息，
  // 否则 OpenAI 兼容协议错位（"tool call result does not follow tool call"）。
  // 因此只有当最后一条消息是 tool（或 user/assistant 且无 tool_calls）时才插。
  const last = s.messages[s.messages.length - 1];
  const safeToInsert =
    !last ||
    last.role === "tool" ||
    (last.role === "assistant" && !last.tool_calls?.length);
  if (safeToInsert) {
    s.messages.push({ role: "user", content: `（用户补充说明：${t}）` });
  } else {
    // 不安全位置：暂存，等下一轮开始时由 flush 逻辑插入
    s.pendingInterjections.push(t);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* LLM 调用（多 provider failover）                                     */
/* ------------------------------------------------------------------ */

import {
  buildProviders, pickProvider, markFailed, markHealthy, isFailoverError, probeProviders,
  type LLMProvider,
} from "./llm-providers";

interface CallResult {
  message: SessionMessage;
  reasoning?: string;
  usage?: { prompt: number; completion: number; total: number };
  provider: string; // 实际使用的模型名
}

/** LLM 单次调用超时（可由 LLM_TIMEOUT_MS 覆盖）——防止挂死拖垮整条流。
 * 分档：supervisor/reviewer 45s；analyst 输出长（平均 ~47s）给 90s；
 * 不可达主模型在 Windows 上 TCP 连接超时 20-80s，收紧下限让 failover 尽快触发 */
function llmTimeoutFor(agent: SubAgent): number {
  const base = Number(process.env.LLM_TIMEOUT_MS) || 45_000;
  return agent === "analyst" ? Math.max(base, 90_000) : base;
}

/**
 * 剥离内嵌在 content 里的 <think>思考链标签。
 *
 * 部分模型（MiniMax-M3 等）不提供 reasoning_content 字段，而是把思考过程
 * 直接写进 content 的 <think>...</think> 标签里。若不剥离：
 *   ① 思考过程会混进正文推送给用户
 *   ② 正文 token 被思考占用，可能导致正文为空
 * 返回：清洗后的正文 + 提取出的思考链
 */
export function splitThinkTags(raw: string): { content: string; reasoning?: string } {
  if (!raw || !raw.includes("<think>")) return { content: raw ?? "" };
  const reasoningParts: string[] = [];
  const content = raw.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner) => {
    reasoningParts.push(inner.trim());
    return "";
  });
  const reasoning = reasoningParts.join("\n").trim();
  return {
    content: content.trim(),
    reasoning: reasoning || undefined,
  };
}

/** 单次原始 HTTP 调用（不 failover） */
async function rawCall(
  p: LLMProvider,
  messages: SessionMessage[],
  tools: unknown[] | undefined,
  sessionId: string | undefined,
  agent: SubAgent
): Promise<CallResult> {
  const t0 = Date.now();
  const res = await fetch(`${p.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({
      model: p.model,
      messages,
      ...(tools ? { tools } : {}),
      stream: false,
      max_tokens: agent === "analyst" ? 3000 : agent === "reviewer" ? 2000 : undefined,
      // 思维链分级（实测教训）：
      // - supervisor 决策必须保留推理：无思维链时模型会跳过工具直接文本回答
      //   （实测 money 用例 10 tools → 0 tools，退化成聊天机器人）
      // - analyst/reviewer 是结构化任务，关掉提速
      ...(agent === "supervisor" ? {} : { thinking: { type: "disabled" } }),
    }),
    signal: AbortSignal.timeout(llmTimeoutFor(agent)),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    db.logLLMUsage(sessionId ?? null, agent, p.name, 0, 0, Date.now() - t0, false);
    throw new Error(`LLM 调用失败(${res.status}): ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  db.logLLMUsage(
    sessionId ?? null, agent, p.name,
    json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0,
    Date.now() - t0, true
  );
  markHealthy(p);
  const choice = json.choices?.[0];
  // Provider 适配：部分模型（如 MiniMax）把思考链内嵌在 content 的 <think> 标签里，
  // 且没有 reasoning_content 字段 —— 必须剥离，否则思考过程会混进正文推给用户
  const { content, reasoning } = splitThinkTags(choice?.message?.content ?? "");
  return {
    message: {
      role: "assistant",
      content,
      tool_calls: choice?.message?.tool_calls,
    },
    reasoning: choice?.message?.reasoning_content ?? reasoning,
    usage: json.usage,
    provider: p.name,
  };
}

/** 非流式调用（决策/分析/审校）——失败自动切换备用 provider */
async function callLLM(
  config: LLMProvider | null,
  messages: SessionMessage[],
  tools?: unknown[],
  sessionId?: string,
  agent: SubAgent = "supervisor"
): Promise<CallResult> {
  const all = buildProviders();
  if (all.length === 0) throw new Error("未配置任何 LLM provider");

  // 尝试顺序：首选（会话粘住的/健康的）→ 其余未失败的
  const preferred = pickProvider(config ?? undefined) ?? all[0];
  const order = [preferred, ...all.filter((p) => p !== preferred)];

  let lastErr: unknown = null;
  for (const p of order) {
    try {
      return await rawCall(p, messages, tools, sessionId, agent);
    } catch (e) {
      lastErr = e;
      if (isFailoverError(e)) {
        markFailed(p);
        continue; // 切下一个 provider
      }
      throw e; // 业务错误（4xx 参数问题等）不切换
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("所有 LLM provider 均不可用");
}

/** 流式调用（撰写者）——首 token 前失败自动切换备用 provider；输出开始后不再切换 */
async function* streamLLM(
  config: LLMProvider | null,
  messages: SessionMessage[],
  sessionId: string | undefined,
  agent: SubAgent = "writer"
): AsyncGenerator<string> {
  const all = buildProviders();
  if (all.length === 0) throw new Error("未配置任何 LLM provider");
  const preferred = pickProvider(config ?? undefined) ?? all[0];
  const order = [preferred, ...all.filter((p) => p !== preferred)];

  let lastErr: unknown = null;
  for (const p of order) {
    const gotAnyOutput = yield* tryStreamOnce(p, messages, sessionId, agent, (e) => { lastErr = e; });
    if (gotAnyOutput === "ok") return; // 成功跑完
    // gotAnyOutput === "pre-output-fail"：还没输出任何内容，可安全换下一个 provider 重试
  }
  throw lastErr instanceof Error ? lastErr : new Error("所有 LLM provider 均不可用（流式）");
}

/** 单次流式尝试：返回 "ok"（完成）或 "pre-output-fail"（首 token 前失败，可重试） */
async function* tryStreamOnce(
  p: LLMProvider,
  messages: SessionMessage[],
  sessionId: string | undefined,
  agent: SubAgent,
  onFail: (e: unknown) => void
): AsyncGenerator<string, "ok" | "pre-output-fail"> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${p.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages,
        stream: true,
        // 流式调用方：writer（6000，长文创作）与 analyst（2500，精简笔记）
        max_tokens: agent === "analyst" ? 2500 : 6000,
        thinking: { type: "disabled" },
        // 请求 usage 统计（OpenAI 兼容：usage 只在最后一个分片返回）
        stream_options: { include_usage: true },
      }),
      // 流式给更宽的超时（首 token 慢 + 流式传输）
      signal: AbortSignal.timeout(llmTimeoutFor("writer") * 2),
    });
  } catch (e) {
    db.logLLMUsage(sessionId ?? null, agent, p.name, 0, 0, Date.now() - t0, false);
    onFail(e);
    if (isFailoverError(e)) markFailed(p);
    return "pre-output-fail";
  }
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    db.logLLMUsage(sessionId ?? null, agent, p.name, 0, 0, Date.now() - t0, false);
    const err = new Error(`LLM 流式调用失败(${res.status}): ${errText.slice(0, 200)}`);
    onFail(err);
    if (isFailoverError(err, res.status)) markFailed(p);
    return "pre-output-fail";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalChars = 0;
  const streamFilter = createStreamThinkFilter();
  const reasoningParts: string[] = [];
  /** 流式 usage（OpenAI 兼容协议：usage 在最后一个分片，需 stream_options.include_usage） */
  let usagePrompt = 0;
  let usageCompletion = 0;
  let usageAvailable = false;

  /** 落库：优先用网关给的真实 usage，缺失时用字符数估算并标注 */
  const logUsage = (ok: boolean) => {
    const estPrompt = usageAvailable ? usagePrompt : Math.round(totalChars * 1.5);
    const estCompletion = usageAvailable ? usageCompletion : totalChars;
    db.logLLMUsage(
      sessionId ?? null, agent, p.name,
      estPrompt, estCompletion, Date.now() - t0, ok
    );
  };

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 流中断：若已有输出则放弃（不切避免重复推送）；无输出则可重试
      logUsage(totalChars === 0);
      onFail(e);
      if (totalChars === 0 && isFailoverError(e)) markFailed(p);
      return totalChars === 0 ? "pre-output-fail" : "ok";
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        logUsage(true);
        markHealthy(p);
        return "ok";
      }
      try {
        const json = JSON.parse(data);
        // 流式 usage：仅在带 include_usage 的最后一个分片出现
        if (json.usage) {
          usageAvailable = true;
          usagePrompt = json.usage.prompt_tokens ?? 0;
          usageCompletion = json.usage.completion_tokens ?? 0;
        }
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          // 标准思考链字段（glm 等）——单独透出
          reasoningParts.push(delta.reasoning_content);
        }
        if (delta?.content) {
          // 内容可能内嵌 <think> 标签（MiniMax 等），需流式剥离
          const { content: clean, reasoning } = streamFilter.push(delta.content);
          if (reasoning) reasoningParts.push(reasoning);
          if (clean) { totalChars += clean.length; yield clean; }
        }
      } catch { /* 忽略 */ }
    }
  }
  // 流结束：冲刷过滤器残留
  const tail = streamFilter.flush();
  if (tail.content) { totalChars += tail.content.length; yield tail.content; }
  if (tail.reasoning) reasoningParts.push(tail.reasoning);

  logUsage(true);
  markHealthy(p);
  return "ok";
}

/**
 * 流式 think 标签过滤器（状态机）
 *
 * 难点：<think> 标签可能跨 SSE chunk 分割（"…<thi" + "nk>思考…</think>"），
 * 所以必须保留不完整的尾部片段到下一个 chunk 再判断。
 */
function createStreamThinkFilter() {
  let buf = "";        // 待判定的缓冲
  let inThink = false; // 当前是否在 think 区内

  return {
    /** 输入一个 chunk，返回可安全输出的正文与提取到的思考链 */
    push(text: string): { content: string; reasoning?: string } {
      buf += text;
      let out = "";
      const reasoningParts: string[] = [];

      while (true) {
        if (inThink) {
          const end = buf.indexOf("</think>");
          if (end === -1) {
            // 未闭合：保留可能是半个标签的尾巴，其余都是思考内容
            const keep = buf.match(/<\/?thi?nk?>?$/);
            const safeLen = keep ? buf.length - keep[0].length : 0;
            if (safeLen > 0) { reasoningParts.push(buf.slice(0, safeLen)); buf = buf.slice(safeLen); }
            break;
          }
          reasoningParts.push(buf.slice(0, end));
          buf = buf.slice(end + "</think>".length);
          inThink = false;
          continue;
        }
        const start = buf.indexOf("<think>");
        if (start === -1) {
          // 没有开始标签：输出全部，但保留可能是半个开始标签的尾巴
          const keep = buf.match(/<$/);
          const safeLen = keep ? buf.length - keep[0].length : buf.length;
          if (safeLen > 0) { out += buf.slice(0, safeLen); buf = buf.slice(safeLen); }
          break;
        }
        out += buf.slice(0, start);
        buf = buf.slice(start + "<think>".length);
        inThink = true;
      }

      const reasoning = reasoningParts.join("").trim();
      return { content: out, reasoning: reasoning || undefined };
    },

    /** 流结束时冲刷残留 */
    flush(): { content: string; reasoning?: string } {
      const rest = buf;
      buf = "";
      if (inThink) {
        inThink = false;
        return { content: "", reasoning: rest.trim() || undefined };
      }
      return { content: rest, reasoning: undefined };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Supervisor 工具定义                                                  */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "混合检索塔罗典籍知识库（BM25+向量 RRF 融合，78 张韦特牌）。当需要了解某张牌的详细牌意、或按主题查找相关牌时调用。\n" +
        "【重要】一次查询可包含多张牌名，用空格分隔即可批量检索，例如 query=\"权杖七 宝剑八 圣杯三\"。\n" +
        "请尽量合并查询（同一轮内把所有需要的牌放进一次调用），不要为每张牌单独调用一次 —— 这会成倍增加耗时与 token。\n" +
        "返回带相关度分数与命中通道的知识片段。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词，可含多个牌名或主题关键词，用空格分隔（如\"权杖七 宝剑八\"）" },
          top_k: { type: "number", description: "返回条数，默认 5；合并查询多张牌时建议 8~10" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draw_cards",
      description:
        "抽取塔罗牌。spread 决定牌阵：'three' 三张时间流（过去/当下/未来），'single' 单张聚焦。AI 可依据问题性质自行选择。注意：若想请用户亲手选牌（体验更佳），应改用 offer_card_selection。",
      parameters: {
        type: "object",
        properties: {
          spread: { type: "string", enum: ["three", "single"], description: "牌阵类型" },
        },
        required: ["spread"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "offer_card_selection",
      description:
        "展开扇形牌阵，请用户凭直觉亲手选出 3 张牌（记录选牌顺序与犹豫时长，注入解读上下文）。比随机抽牌更具仪式感，是推荐的默认方式。",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "可选牌数，默认 3" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "establish_contract",
      description:
        "【承约阶段 · 占卜第一步】在抽牌之前，先把你听到的问题复述成一个**更具体、可被牌回答**的问题，并请用户确认。\n" +
        "真实塔罗师在碰牌前都会做这一步：把「我的运势怎么样」收敛成「我在感情里会不会主动」。\n" +
        "同时声明本次占卜的牌阵范围（scope，如「我看过去、现在，和那条你正在犹豫的路」）。\n" +
        "【调用时机】用户刚说完问题、尚未抽牌时调用一次。若用户已澄清过，可直接给出你确认后的理解。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "你复述/收敛后的具体问题（30~60 字），用第二人称对用户说",
          },
          scope: {
            type: "string",
            description: "本次占卜的牌阵范围声明（15~40 字），如「我看过去与当下，以及你正在犹豫的那条路」",
          },
          confirm_options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
            description: "2~3 个确认选项（如「对，就是这个」「其实我想问别的」「再具体一点」）",
          },
        },
        required: ["question", "scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_three_questions",
      description:
        "【呼召阶段 · 洗牌时问的三件事】在翻牌之前，请用户回答三个问题，这三个回答会**直接成为解读的骨架**（分别对应三张牌各自要讲什么、以及最终的行动建议）：\n" +
        "① 你最想知道什么？（想知道的信息/结果）\n② 你打算做什么？（已经决定或准备采取的行动）\n③ 你需要防什么？（担心的风险/盲区）\n" +
        "【调用时机】选牌之前。问题要贴着用户刚确认的那个具体问题来问，不要放之四海而皆准。",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 3,
            description: "三个问题，每个 15~30 字，顺序固定：想知道什么 / 打算做什么 / 需要防什么",
          },
        },
        required: ["questions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "向用户提出澄清问题，挂起占卜流程等待人类回答（人机协同）。在问题模糊时调用。每次占卜最多 2 次。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问用户的问题（简短、口语化）" },
          options: { type: "array", items: { type: "string" }, description: "预设选项（2~4 个，可不给）" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fate_crossroads",
      description:
        "命运岔路：解读中段，向用户呈现 2~3 条命运走向让其选择，后续解读（尤其未来牌）按选择分支。让用户参与塑造自己的解读，增强人机协同。\n" +
        "【必须同时提供 prompt 和 branches】branches 是给用户点击的选项列表（2~3 条，每条不超过 30 字）；" +
        "**不要把选项写进 prompt 里**——prompt 只是引子，选项必须放在 branches 数组里，否则用户看不到可选项。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "岔路引子（20~60 字），只写情境铺垫，不要列举选项" },
          branches: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
            description: "2~3 条走向描述（每条不超过 30 字），用户将从中选择一条",
          },
        },
        required: ["prompt", "branches"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reveal_card",
      description:
        "【逐张解读 · 翻牌】翻到牌阵中的下一张牌，先**念牌**：客观描述牌面画面 + 典籍牌意 + 向用户提一个**针对性的确认问题**。\n" +
        "这一步只讲这一张牌，不涉及其他牌。用户回答后再调用 interpret_card 讲透它。\n" +
        "【确认问题必须可回答】形式是二选一或三选一，选项要贴着用户的原话与情绪，\n" +
        "例如「你在这件事上，更像是『已经麻木了』还是『其实不甘心』？」——不要问空泛的「你觉得呢」。\n" +
        "【牌意必须带引文编号】meaning 引用典籍牌意时用 [n] 标注（对应 rag_search 返回的编号，如「新的开始、冒险 [3]」），\n" +
        "并在牌意开头写「典籍所载：…」——引文可点击溯源，没有引文标注的解读会被审校打回。",
      parameters: {
        type: "object",
        properties: {
          card_index: { type: "number", description: "第几张牌（从 0 开始）" },
          narrative: { type: "string", description: "牌面画面描述（40~70 字），客观说画面里有什么" },
          meaning: { type: "string", description: "典籍牌意（30~50 字），用【n】标注引用" },
          question: { type: "string", description: "向用户提的确认问题（20~40 字），要具体、可回答" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
            description: "确认问题的选项（2~3 个，用户可点选或自由输入）",
          },
        },
        required: ["card_index", "narrative", "meaning", "question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "interpret_card",
      description:
        "【逐张解读 · 讲透这一张】结合用户对确认问题的回答，把**这一张牌**讲透（100~150 字）：\n" +
        "牌意如何落在这个用户的处境上、用户在确认问题里的反应说明了什么。\n" +
        "只讲当前这一张牌，不要提前讲后面的牌。讲完后可以继续 reveal_card 翻下一张。\n" +
        "【必须带引文】引用典籍牌意时用「典籍所载：… [n]」标注（n 对应 rag_search 返回的编号）——\n" +
        "没有引文标注的解读会被审校打回。",
      parameters: {
        type: "object",
        properties: {
          card_index: { type: "number", description: "第几张牌（从 0 开始）" },
          reading: { type: "string", description: "这一张牌的完整解读（100~150 字）" },
        },
        required: ["card_index", "reading"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_reading",
      description:
        "【收束阶段 · 收尾追问】所有牌都解读完之后调用。\n" +
        "1) 先给一段收束语（80~120 字）：把三张牌连成一个故事，**回扣用户最初确认的那个具体问题**，并给出**唯一一条**可执行的下一步（不是十条建议）；\n" +
        "2) 同时附带一个「三段里哪一段最贴近你」的收尾追问，让用户自然进入追问环节。\n" +
        "【边界提醒】占卜只显示倾向，不是判决——用一句话点到即止。",
      parameters: {
        type: "object",
        properties: {
          closing: { type: "string", description: "收束语（80~120 字）：串起三张牌 + 回扣原问题 + 一条行动建议 + 边界提醒" },
          question: { type: "string", description: "收尾追问（15~30 字），如「这三段里，哪一段最贴近你现在的状态？」" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
            description: "收尾追问的选项（如「过去那段」「现在那段」「未来那段」）",
          },
        },
        required: ["closing", "question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_reading",
      description:
        "【最终综合】**只有在所有牌都用 reveal_card + interpret_card 逐张讲完之后**，才调用这个工具做最终综合：\n" +
        "它会启动分析师→撰写者→审校者管线，把三张牌串成一个故事、回扣用户最初的问题。\n" +
        "⚠️ 不要用它代替逐张解读——如果还没讲过任何一张牌，就先用 reveal_card。",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", description: "解读侧重，如\"情感剖析\"\"行动建议\"" },
        },
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/* 工具执行器                                                           */
/* ------------------------------------------------------------------ */

function execDrawCards(spread: string, session: AgentSession) {
  const n = spread === "single" ? 1 : 3;
  const pool = [...TAROT_CARDS];
  const drawn: DrawnCard[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const card = pool.splice(idx, 1)[0];
    drawn.push({ card, reversed: Math.random() < 0.35 });
  }
  session.drawnCards = drawn;
  const posNames = ["过去", "当下", "未来"];
  const cards = drawn.map((d, i) => ({
    id: d.card.id, nameZh: d.card.nameZh, image: d.card.image,
    reversed: d.reversed, pos: n === 1 ? "核心指引" : posNames[i],
  }));
  const summary = drawn.map((d, i) => `${cards[i].pos}=${d.card.nameZh}${d.reversed ? "(逆位)" : ""}`).join("、");
  db.updateSessionCards(session.id, cards);
  return { summary, cards };
}

/** 检索预算：超过此次数后注入"检索已充分，立即收尾"提示（防无限检索） */
const RAG_BUDGET = 3;

/**
 * P2.1：从用户应答中提取情绪关键词（规则式，轻量零成本）。
 * 占卜师"记得你说过很紧张"——情绪档案贯穿解读与追问，
 * 而不是每次回答都当陌生人重新问一遍。
 */
const EMOTION_LEXICON: Array<{ tag: string; words: string[] }> = [
  { tag: "紧张不安", words: ["紧张", "焦虑", "担心", "忐忑", "害怕", "慌", "没底", "心虚", "压力"] },
  { tag: "迷茫", words: ["迷茫", "不知道", "纠结", "犹豫", "选不", "拿不准", "看不清", "困惑"] },
  { tag: "期待希望", words: ["期待", "希望", "想要", "盼", "希望", "憧憬", "向往"] },
  { tag: "失落受挫", words: ["失落", "失败", "受挫", "没回音", "石沉大海", "被拒", "分手", "失恋", "难过", "崩溃"] },
  { tag: "渴望改变", words: ["想改变", "想换", "想逃离", "受不了", "厌倦", "想重新开始"] },
  { tag: "兴奋跃跃", words: ["兴奋", "激动", "跃跃欲试", "迫不及待", "机会来了"] },
];

function extractEmotionTags(text: string): string[] {
  const tags: string[] = [];
  for (const { tag, words } of EMOTION_LEXICON) {
    if (words.some((w) => text.includes(w))) tags.push(tag);
  }
  return tags.slice(0, 3); // 最多 3 个，避免堆砌
}

/**
 * 从叙述性 prompt 里抠出候选分支（模型漏传 branches 时的兜底）。
 *
 * 识别常见编号格式：
 *   "1. xxx" / "①xxx" / "A. xxx" / "一、xxx"
 * 以及被引号包裹的并列项："…，或「这个」「那个」…"
 * 抠不出则返回空数组，由调用方用通用选项兜底（绝不返回空导致 UI 死锁）。
 *
 * 自检：scripts/test-crossroads-fallback.cjs（改算法时同步两处）
 */
function extractBranchesFromPrompt(prompt: string): string[] {
  const branches: string[] = [];

  // ① 编号项
  //    两步走：先单独匹配"编号标记"（不含前置条件，避免吃掉分隔符），
  //           再按标记位置切分文本，逐段清洗。
  //    两种标记形态：
  //      A. 数字/中文数字/字母 + 分隔符（1. / 一、 / A.）
  //      B. 圆圈数字（自带分隔符，后面直接跟内容：①继续坚持）
  const marker = /[（(]?\s*((?:[0-9]{1,2}|[一二三四五六七八九十]|[A-Ha-h])[）).、．:：]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/g;
  const marks: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(prompt)) !== null) {
    // 排除"1.5"小数、"2024年"年份：标记前不能是数字
    const before = prompt[m.index - 1] ?? "";
    if (/[0-9]/.test(before) && /^[0-9]/.test(m[1])) continue;
    marks.push({ start: m.index, end: marker.lastIndex });
  }
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].end;
      const end = i + 1 < marks.length ? marks[i + 1].start : prompt.length;
      const body = prompt.slice(start, end).replace(/[；;。\n、，]+$/, "").trim();
      if (body.length >= 2 && body.length <= 60) branches.push(body);
    }
    if (branches.length >= 2) return branches.slice(0, 4);
  }

  // ② 引号并列：「xxx」「xxx」
  const quoted = prompt.match(/[「『【]([^」』】]{2,50})[」』】]/g);
  if (quoted) {
    const cleaned = quoted.map((q) => q.replace(/^[「『【]|[」』】]$/g, "").trim()).filter((q) => q.length >= 2);
    if (cleaned.length >= 2) return cleaned.slice(0, 4);
  }

  // ③ 或字并列
  const alt = prompt.split(/[，,]\s*(?:或者|还是|或是|或)\s*/);
  if (alt.length >= 2) {
    const parts = alt.map((s) => s.trim()).filter((s) => s.length >= 3 && s.length <= 60);
    if (parts.length >= 2) return parts.slice(0, 4);
  }

  return branches;
}

/**
 * 汇总逐张解读为最终正文（落库用）。
 * 格式与前端 CitedReading 的段落解析一致：【牌面·位置·牌名】 + 正文段
 */
function buildFinalReading(session: AgentSession): string {
  const parts: string[] = [];
  for (const slot of session.cardReadings) {
    if (!slot.reading) continue;
    parts.push(`【牌面·${slot.pos}·${slot.nameZh}】${slot.reading}`);
  }
  if (parts.length === 0) {
    // 兜底：没有逐张解读（走了旧管线）→ 用 session.reading
    return session.reading ?? "";
  }
  return parts.join("\n\n");
}

/** 取（或创建）某张牌的解读槽位 */
function ensureCardSlot(session: AgentSession, idx: number): AgentSession["cardReadings"][number] {
  const drawn = session.drawnCards[idx];
  const cardId = drawn?.card.id ?? `unknown-${idx}`;
  const nameZh = drawn?.card.nameZh ?? `第${idx + 1}张`;
  const posNames = ["过去", "当下", "未来"];
  const pos = session.drawnCards.length === 1 ? "核心指引" : (posNames[idx] ?? `第${idx + 1}张`);
  let slot = session.cardReadings.find((r) => r.cardId === cardId);
  if (!slot) {
    slot = { cardId, nameZh, pos };
    session.cardReadings.push(slot);
  }
  return slot;
}

async function execRagSearch(query: string, topK: number, session: AgentSession) {
  // ---- 重复检索负反馈（防死循环的关键）----
  // 归一化查询（去空格+小写）后与历史比对；重复查询直接返回"已检索过"标记，
  // 模型收到显式负反馈就不会再撞同一面墙（实测：max_rounds 会话里同一查询重复了 5 次）
  const normalized = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (session.ragQueryHistory.includes(normalized)) {
    return {
      summary: `⚠️ 该查询「${query.slice(0, 20)}」此前已检索过（内容见上文，无需重复）。信息已足够，请立即调用 write_reading 开始解读。`,
      currentHits: [],
      allHits: session.ragHits,
      duplicate: true,
    };
  }
  session.ragQueryHistory.push(normalized);
  session.ragCallCount++;

  const k = Math.min(Math.max(topK || 5, 1), 10);
  const currentHits = await hybridSearch(query, k);
  // ⚠️ 累积而非覆盖：supervisor 一场占卜常检索多次（每张牌一次），
  // 覆盖会导致解读里的 [n] 编号对应不上知识面板（引文闭环断裂）。
  // 按 chunkId 去重合并，编号即检索顺序，知识面板与 [n] 永远一致。
  const seen = new Set(session.ragHits.map((h) => h.chunkId));
  for (const h of currentHits) {
    if (!seen.has(h.chunkId)) {
      session.ragHits.push(h);
      seen.add(h.chunkId);
    }
  }
  // 上限保护：累积命中过多时保留最新的（旧牌通常已被使用）
  if (session.ragHits.length > 12) session.ragHits = session.ragHits.slice(-12);

  const budgetNote = session.ragCallCount >= RAG_BUDGET
    ? "（已达检索预算上限，请立即 write_reading）"
    : "";
  const summary = `检索到 ${currentHits.length} 条：${currentHits.slice(0, 3).map((h) => `${h.cardNameZh}(${h.score},${h.channels.join("+")})`).join("、")}${currentHits.length > 3 ? "…" : ""}（累计 ${session.ragHits.length} 条）${budgetNote}`;
  return { summary, currentHits, allHits: session.ragHits, duplicate: false };
}

/* ------------------------------------------------------------------ */
/* 子 Agent 管线（analyst → writer → reviewer）                         */
/* ------------------------------------------------------------------ */

/** ① 牌意分析师：逐牌结构化笔记 */
async function* runAnalyst(
  config: LLMProvider | null, session: AgentSession
): AsyncGenerator<AgentEvent> {
  yield { type: "subagent", subagent: { agent: "analyst", action: "开始逐牌分析" } };

  const cardKnowledge = buildCardKnowledge(session.drawnCards);
  const ragContext = session.ragHits.length
    ? session.ragHits.map((h, i) => `[${i + 1}] ${h.source}\n    ${h.snippet}`).join("\n")
    : "（未检索）";

  const messages: SessionMessage[] = [
    {
      role: "system",
      content: buildAnalystPrompt(),
    },
    {
      role: "user",
      content: `用户问题：${session.question}
用户已澄清的信息：见上文对话
牌面知识：\n${cardKnowledge}
RAG 检索结果：\n${ragContext}
请逐牌分析（务必精简）。`,
    },
  ];

  // 流式收集分析师笔记：边产出边推给前端（消灭 analyst 完成→writer 首token之间的静默期）
  let notes = "";
  for await (const chunk of streamLLM(config, messages, session.id, "analyst")) {
    notes += chunk;
    yield { type: "reasoning", reasoning: chunk };
  }
  session.analystNotes = notes.trim();
  yield {
    type: "subagent",
    subagent: { agent: "analyst", action: "分析完成", detail: `笔记 ${session.analystNotes.length} 字` },
  };
}

/** ② 撰写者：基于笔记流式撰写（writer 的产出直接流给用户） */
async function* runWriter(
  config: LLMProvider | null, session: AgentSession, focus: string,
  revision?: string // 审校者的修改指令（重写时传入）
): AsyncGenerator<AgentEvent, string> {
  yield {
    type: "subagent",
    subagent: { agent: "writer", action: revision ? "根据审校意见重写中" : "开始撰写命运之卷" },
  };

  const ragContext = session.ragHits.length
    ? session.ragHits.map((h, i) => `[${i + 1}] ${h.source}\n    ${h.snippet}`).join("\n")
    : "（未检索）";

  // P1.3：犹豫时长入戏——真实塔罗师会说"你在那张牌前停留了很久"
  const dwellNote = (() => {
    if (session.dwellTimes.length !== session.drawnCards.length) return undefined;
    if (session.dwellTimes.some((d) => d < 0)) return undefined; // 随机代抽无数据
    const maxIdx = session.dwellTimes.indexOf(Math.max(...session.dwellTimes));
    const card = session.drawnCards[maxIdx];
    if (!card) return undefined;
    return `选牌行为：用户在「${card.card.nameZh}」（${["过去", "当下", "未来"][maxIdx] ?? "核心"}）前犹豫最久（${session.dwellTimes[maxIdx]}ms）。可在解读中自然地点出这一细节（如"你在这张牌前停留了很久，说明它触动了你"），但不要报毫秒数字。`;
  })();

  // P2.1：情绪档案入 prompt——"记得你说过很紧张"
  const emotionNote = session.emotionTags.length
    ? `用户在对话中流露的情绪：${session.emotionTags.join("、")}。解读中要回应这份情绪（如安抚、确认、鼓励），让用户感到被听见。`
    : undefined;

  const messages: SessionMessage[] = [
    {
      role: "system",
      content: buildWriterPrompt(session.persona, [dwellNote, emotionNote].filter(Boolean).join("\n") || undefined),
    },
    {
      role: "user",
      content: `用户问题：${session.question}
牌面知识：
${buildCardKnowledge(session.drawnCards)}

分析师笔记：
${session.analystNotes}

RAG 检索结果（引用编号对应）：
${ragContext}

解读侧重：${focus}
${revision ? `\n⚠️ 审校意见（上一版被退回，必须针对性修改）：\n${revision}\n请重写全文。` : ""}

现在撰写解读正文。`,
    },
  ];

  let full = "";
  for await (const chunk of streamLLM(config, messages, session.id, "writer")) {
    full += chunk;
    yield { type: "delta", delta: chunk };
  }
  session.messages.push({ role: "assistant", content: `（撰写者产出解读 ${full.length} 字）` });
  // 供审校
  (session as unknown as { __lastReading?: string }).__lastReading = full;
  yield {
    type: "subagent",
    subagent: { agent: "writer", action: revision ? "重写完成" : "初稿完成", detail: `${full.length} 字` },
  };
  return full;
}

/** 审校结果结构 */
interface ReviewResult {
  pass: boolean;
  scores: { grounding: number; empathy: number; tone: number };
  comment: string;
  revision?: string;
  /** 解析级别（1=严格JSON 2=括号提取 3=正则兜底），0=解析失败 */
  parseLevel?: 0 | 1 | 2 | 3;
  /** 是否重试过 */
  retried?: boolean;
}

/**
 * ③ 审校者：三维度打分 + Reflexion 修改指令
 *
 * 解析策略（三级 + 重试，见 robust-json.ts）：
 *   严格 JSON → 平衡括号提取 → 正则逐字段兜底
 *   全失败 → 带纠正提示重试一次 → 仍失败则明确标记"审校未完成"
 *   ⚠️ 绝不默认通过（那会让质量门控形同虚设）
 */
async function* runReviewer(
  config: LLMProvider | null, session: AgentSession, reading: string
): AsyncGenerator<AgentEvent, ReviewResult> {
  yield { type: "subagent", subagent: { agent: "reviewer", action: "审校中（典籍忠实/共情/语气）" } };

  // 典籍依据 = RAG 检索结果 + 用户抽到/选中的牌面知识（两者都是合法引用来源）
  const ragContext = session.ragHits.length
    ? session.ragHits.map((h, i) => `[${i + 1}] ${h.source}\n    ${h.snippet}`).join("\n")
    : "（未检索）";
  const cardNames = session.drawnCards.map((d) => d.card.nameZh).join("、");

  const systemPrompt = buildReviewerPrompt(session.persona);

  const userContent = `用户问题：${session.question}
占卜师人格：${session.persona.name}（${session.persona.desc}）
用户抽到的牌：${cardNames}

【牌面知识】（合法引用来源，牌意原文）
${buildCardKnowledge(session.drawnCards)}

RAG 检索结果（另一合法引用来源）：
${ragContext}

待审校解读：
${reading}

请审校。`;

  // ---- 解析器：三级 + 正则兜底 ----
  const extractors = (text: string): Partial<ReviewResult> | null => {
    const grounding = extractScore(text, "grounding");
    const empathy = extractScore(text, "empathy");
    const tone = extractScore(text, "tone");
    if (grounding === undefined && empathy === undefined && tone === undefined) return null;
    const comment = extractString(text, "comment") ?? "";
    const revision = extractString(text, "revision") ?? "";
    const scores = {
      grounding: grounding ?? 0,
      empathy: empathy ?? 0,
      tone: tone ?? 0,
    };
    return {
      scores,
      comment,
      revision,
      pass: scores.grounding >= 7 && scores.empathy >= 6 && scores.tone >= 6,
    };
  };

  let parsed: Partial<ReviewResult> | null = null;
  let parseLevel: 0 | 1 | 2 | 3 = 0;
  let retried = false;
  let parseError = "";

  /** 流式收集审校内容（审校输出很短，流式能显著降低体感延迟） */
  const collectReview = async (msgs: SessionMessage[]): Promise<string> => {
    let out = "";
    for await (const chunk of streamLLM(config, msgs, session.id, "reviewer")) {
      out += chunk;
    }
    return out;
  };

  // ---- 第一次尝试（流式） ----
  {
    const raw = await collectReview([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ]);
    const p = parseLLMJSON<ReviewResult>(raw, extractors);
    parsed = p.data ?? null;
    parseLevel = p.level;
    parseError = p.error ?? "";
  }

  // ---- 解析失败 → 带纠正提示重试一次 ----
  if (!parsed) {
    retried = true;
    yield {
      type: "subagent",
      subagent: { agent: "reviewer", action: "输出格式异常，重试审校" },
    };
    const raw = await collectReview([
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
      { role: "assistant", content: "（上一次的输出无法被解析）" },
      {
        role: "user",
        content: `你的上一次输出无法解析。请**只输出一个 JSON 对象**，不要包含 markdown 代码块、不要有任何解释文字。
格式示例：{"pass": true, "scores": {"grounding": 8, "empathy": 9, "tone": 8}, "comment": "总评", "revision": ""}`,
      },
    ]);
    const p = parseLLMJSON<ReviewResult>(raw, extractors);
    parsed = p.data ?? null;
    parseLevel = p.level;
    parseError = p.error ?? "";
  }

  // ---- 仍失败：明确标记"审校未完成"，不谎报通过 ----
  if (!parsed) {
    const failed: ReviewResult = {
      pass: true, // 解析失败时不阻断流程（解读仍要交付给用户）
      scores: { grounding: 0, empathy: 0, tone: 0 },
      comment: `⚠️ 审校未完成：模型输出无法解析${retried ? "（已重试）" : ""}。${parseError}`,
      revision: "",
      parseLevel: 0,
      retried,
    };
    yield { type: "review", review: { ...failed } };
    yield {
      type: "subagent",
      subagent: { agent: "reviewer", action: "审校未完成（输出解析失败）" },
    };
    (session as unknown as { __revision?: string }).__revision = "";
    return failed;
  }

  const scores = {
    grounding: clampScore(parsed.scores?.grounding),
    empathy: clampScore(parsed.scores?.empathy),
    tone: clampScore(parsed.scores?.tone),
  };
  const result: ReviewResult = {
    pass: scores.grounding >= 7 && scores.empathy >= 6 && scores.tone >= 6,
    scores,
    comment: parsed.comment ?? "",
    revision: parsed.revision ?? "",
    parseLevel,
    retried,
  };

  yield { type: "review", review: { ...result } };
  yield {
    type: "subagent",
    subagent: {
      agent: "reviewer",
      action: result.pass ? "审校通过" : "退回重写",
      detail: `grounding=${scores.grounding} empathy=${scores.empathy} tone=${scores.tone}${parseLevel === 3 ? " (正则兜底)" : ""}`,
    },
  };

  // 存 revision 供 supervisor 决定是否重写
  (session as unknown as { __revision?: string }).__revision = result.pass ? "" : (result.revision || "请全面修改");
  return result;
}

/** 评分裁剪到 0~10 */
function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(10, Math.max(0, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/* 上下文压缩（性能优化）                                              */
/* ------------------------------------------------------------------ */

/**
 * 压缩 rag_search 的观察结果，回填给 LLM。
 *
 * 完整命中（带 80 字符 snippet + 完整来源串）发给前端展示，
 * 但回填给 LLM 的只保留**前 3 条的核心信息**（牌名 + 字段 + 精简片段），
 * 实测能省 30-40% 的 prompt token —— 因为每轮都要重发完整历史。
 */
function compressRagResult(hits: RagHit[]): string {
  if (hits.length === 0) return JSON.stringify({ result: "未检索到相关内容" });
  const top = hits.slice(0, 3).map((h, i) => {
    const card = h.cardNameZh;
    const fieldLabel =
      h.field === "description" ? "叙事" : h.field === "upright" ? "正位" : h.field === "reversed" ? "逆位" : "关键词";
    // 片段截到 40 字，够 LLM 判断相关性
    const brief = h.snippet.length > 40 ? h.snippet.slice(0, 40) + "…" : h.snippet;
    return `[${i + 1}] ${card}·${fieldLabel}: ${brief}`;
  });
  return JSON.stringify({ hits: top, total: hits.length });
}

/**
 * 历史裁剪：把早期的 tool 观察结果压成一句摘要。
 *
 * Agent 每轮都要重发完整历史 → token 随轮次平方增长。
 * 保留 assistant 的**决策轨迹**（它说了什么、调了什么），
 * 但把早期的 tool 返回值压缩（它们的信息已被后续决策吸收）。
 *
 * ⚠️ 豁免清单（绝不压缩——它们是全场核心事实）：
 *   - offer_card_selection / draw_cards：抽到的牌。
 *     实测事故：压缩后 supervisor "忘了"抽了什么牌，开始瞎猜检索
 *     没抽到的牌（权杖十×5 次重复检索 → max_rounds 死循环）。
 *     这些结果只有几十字，压缩收益趋零、代价是灾难性的。
 */
function trimHistory(messages: SessionMessage[], keepFullRounds = 4): SessionMessage[] {
  if (messages.length <= keepFullRounds * 2 + 4) return messages;

  // tool 消息要找到它对应的工具名：从相邻 assistant 消息的 tool_calls 里反查
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }
  /** 抽牌类工具结果永不压缩 */
  const NEVER_COMPRESS = new Set(["offer_card_selection", "draw_cards"]);

  // 找到最近 keepFullRounds 个**可压缩** tool 消息的位置
  const compressibleIndexes: number[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    const name = m.tool_call_id ? toolNameById.get(m.tool_call_id) : undefined;
    if (!name || !NEVER_COMPRESS.has(name)) compressibleIndexes.push(i);
  });
  if (compressibleIndexes.length <= keepFullRounds) return messages;

  const cutBefore = compressibleIndexes[compressibleIndexes.length - keepFullRounds];

  return messages.map((m, i) => {
    if (m.role !== "tool" || i >= cutBefore) return m;
    const name = m.tool_call_id ? toolNameById.get(m.tool_call_id) : undefined;
    if (name && NEVER_COMPRESS.has(name)) return m; // 豁免：抽牌结果常驻
    // 压缩：只保留"检索/操作已完成"的标记，不带具体内容
    return {
      ...m,
      content: JSON.stringify({ result: "（早期结果已压缩）" }),
    };
  });
}

/* ------------------------------------------------------------------ */
/* 主流程：Supervisor 循环                                              */
/* ------------------------------------------------------------------ */

function buildSystemPrompt(session: AgentSession): string {
  return buildSupervisorPrompt(session.persona);
}

export async function* runAgent(
  session: AgentSession,
  question: string,
  opts?: { followup?: string }
): AsyncGenerator<AgentEvent> {
  // provider 选择：会话内粘住上次成功的（风格一致），失败自动切换
  const all = buildProviders();
  if (all.length === 0) {
    yield* runLocalFallback(session, question);
    return;
  }
  // 会话粘住的 provider（首次取健康的第一个）
  const sticky = (session as unknown as { __provider?: LLMProvider }).__provider;
  let config: LLMProvider | null = pickProvider(sticky) ?? all[0];
  (session as unknown as { __provider?: LLMProvider }).__provider = config;

  yield { type: "session", sessionId: session.id };

  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: buildSystemPrompt(session) });
    session.messages.push({ role: "user", content: `我想占卜：${question}` });
    // 记录 prompt 版本，便于后续版本效果对比
    try { db.updateSessionPromptVersion(session.id, PROMPT_VERSION); } catch { /* ignore */ }
  } else if (opts?.followup) {
    session.messages.push({ role: "user", content: `（追问）${opts.followup}` });
    session.messages.push({
      role: "system",
      content: buildFollowupPrompt({
        // 人格声线：追问回答与正式解读同一人格（此前是裸模型声线，割裂感明显）
        personaStyle: session.persona.stylePrompt,
        personaName: session.persona.name,
        // P2.1：情绪档案——追问也记得用户的情绪
        emotionTags: session.emotionTags,
        // 牌面知识常驻：追问时模型手里要有牌意原文，防止凭记忆编造
        cardKnowledge: buildCardKnowledge(session.drawnCards),
        // 检索摘要：压缩版（牌名+字段），不占太多 token
        ragDigest: session.ragHits.length
          ? session.ragHits.map((h) => `${h.cardNameZh}·${h.field === "upright" ? "正位" : h.field === "reversed" ? "逆位" : h.field === "keywords" ? "关键词" : "叙事"}: ${h.snippet.slice(0, 40)}`).slice(0, 6).join("\n")
          : "（未检索）",
      }),
    });
  }

  yield { type: "phase", phase: "analyze", label: `${session.persona.emoji} ${session.persona.name}开始凝听你的问题…` };

  // 轮次上限：逐张解读模式下轮次翻倍
  // 承约1 + 呼召1 + 选牌1 + 检索2 + (翻牌+解读)×3 + 综合1 + 收束1 ≈ 14 轮
  const MAX_ROUNDS = Number(process.env.MAX_ROUNDS) || 22;
  let round = 0;
  // 模型跳过工具直接回答的纠偏计数（首答模式防行为漂移）
  let noToolRetries = 0;
  // 待补齐响应的 tool_call（见下方 extraTools 处理）
  let pendingToolResponses: Array<{ id: string; name: string }> = [];

  /**
   * 补齐被跳过的 tool_call 响应（保持 assistant→tool 配对完整）。
   * 本轮只执行一个 tool_call，其余的必须也有对应的 tool 消息，
   * 否则 OpenAI 兼容协议错位："tool call result does not follow tool call" (400)。
   * 必须在**每次退出前**调用（含 return / 异常路径）。
   */
  const flushPendingToolResponses = () => {
    for (const skipped of pendingToolResponses) {
      session.messages.push({
        role: "tool",
        tool_call_id: skipped.id,
        content: JSON.stringify({
          deferred: true,
          hint: `「${skipped.name}」本轮未执行——一次只做一个动作。请在下一轮单独调用它。`,
        }),
      });
    }
    pendingToolResponses = [];
  };

  // 看门狗：整场占卜的总时长上限（默认 8 分钟）
  // 逐张解读模式轮次多、每轮有用户思考时间，总时长天然更长
  const totalDeadline = Date.now() + (Number(process.env.SESSION_DEADLINE_MS) || 8 * 60 * 1000);

  // try/finally：无论从哪条路径退出（正常 done / 错误 / 超时），
  // 都要补齐被跳过的 tool_call 响应，否则会话历史里的 tool_call_id 未配对，
  // 下一次追问时 MiniMax 会直接返回 400 "tool call result does not follow tool call"。
  try {
  while (round < MAX_ROUNDS) {
    // 补齐上一轮被跳过的 tool_call 响应
    flushPendingToolResponses();

    // ---- 插入暂存的插话（方案 C）----
    // 位置已安全（上一轮 assistant→tool 已配对完成）
    if (session.pendingInterjections.length > 0) {
      for (const t of session.pendingInterjections) {
        session.messages.push({ role: "user", content: `（用户补充说明：${t}）` });
      }
      session.pendingInterjections = [];
    }

    // 看门狗检查：超时 → 放弃并明确标记
    if (Date.now() > totalDeadline) {
      yield { type: "error", error: "占卜耗时超过上限，已中止（可在观测面板查看）" };
      db.failSession(session.id, "deadline_exceeded");
      return;
    }
    round++;
    const roundStart = Date.now();
    let roundPromptTokens: number | undefined;
    const roundToolNames: string[] = [];
    let decision: CallResult;
    try {
      // 历史裁剪：压缩早期 tool 观察结果，降低每轮 prompt token
      let trimmed = trimHistory(session.messages);
      // ---- 临期强制收尾（防 max_rounds 死循环撞墙）----
      // 轮次接近上限时注入"必须立即收尾"指令（只注入到本次调用，不污染会话历史）
      // 注意：逐张解读模式下不能过早催促——还有牌没讲完时催促会导致模型乱来。
      const LATE_ROUND = Math.max(10, MAX_ROUNDS - 6); // 留 6 轮缓冲
      const perCardPending = session.cardReadings.filter((r) => r.reading).length < session.drawnCards.length;
      const needWrapUp = (round >= LATE_ROUND || session.ragCallCount > RAG_BUDGET) && !perCardPending;
      if (needWrapUp && session.drawnCards.length > 0) {
        trimmed = [
          ...trimmed,
          {
            role: "system" as const,
            content: `⚠️ 流程即将到达轮次上限（当前第 ${round} 轮，检索已 ${session.ragCallCount} 次）。你手里已有 ${session.drawnCards.length} 张牌与检索结果，信息完全足够。本轮必须调用 write_reading 启动解读管线，不得再调用任何检索或提问工具。`,
          },
        ];
      }
      decision = await callLLM(config, trimmed, TOOLS, session.id, "supervisor");
      roundPromptTokens = decision.usage?.prompt;
      // failover 生效时更新会话粘住的 provider（保持后续风格一致）——按名称比较，避免对象实例误判
      const used = buildProviders().find((p) => p.name === decision.provider);
      if (used && used.name !== config?.name) {
        config = used;
        (session as unknown as { __provider?: LLMProvider }).__provider = used;
        yield { type: "phase", phase: "analyze", label: `主模型连接不畅，已切换备用模型（${used.name}）` };
      }
    } catch (e) {
      yield { type: "error", error: `占卜师暂时失联：${e instanceof Error ? e.message : "未知错误"}` };
      db.failSession(session.id, "llm_error");
      return;
    }
    if (decision.reasoning) yield { type: "reasoning", reasoning: decision.reasoning };
    // 决策消息原样推入历史（保留全部 tool_calls，保证 assistant→tool 配对完整）
    session.messages.push(decision.message);

    // ---- P1.2：决策附带文本作为对话回应流出 ----
    // supervisor 决策时常带 content（"嗯，我听到了，你其实很在意…"），
    // 此前被丢弃——用户答完话得到死寂。现在流出来，占卜师"每步有回应"。
    //
    // ⚠️ 但当本轮同时要发起 HITL 交互（ask_user/fate_crossroads/选牌）时**不流出**：
    //    模型的 content 往往是"岔路口叙述"（"你打算怎么走？"），
    //    若先流出再弹选项面板，用户会看到一段像提问又没选项的正文——反而更困惑。
    const toolCalls = decision.message.tool_calls;
    const hasHitl = (toolCalls ?? []).some((tc) =>
      ["ask_user", "offer_card_selection", "fate_crossroads"].includes(tc.function.name)
    );
    if (decision.message.content && session.messages.length > 3 && !hasHitl) {
      const intro = decision.message.content.trim();
      if (intro) {
        for (const chunk of intro.match(/[\s\S]{1,6}/g) ?? []) {
          yield { type: "delta", delta: chunk };
        }
        // 换行分隔，与后续解读正文区分
        yield { type: "delta", delta: "\n\n" };
      }
    }

    if (!toolCalls || toolCalls.length === 0) {      // ---- 无工具调用分支 ----
      // 追问模式：纯文本回答是正常路径
      const isFollowup = opts?.followup !== undefined && session.messages.length > 2;
      if (isFollowup) {
        const text = decision.message.content;
        if (text) {
          for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
            yield { type: "delta", delta: chunk };
          }
          db.updateSessionReading(session.id, text);
        }
        yield { type: "done" };
        session.finished = true;
        return;
      }

      // 首答模式：模型跳过工具直接回答 = 无效占卜（没有牌面依据）。
      // 不放行——注入纠偏消息强制其走工具流程，最多重试 2 次（防模型行为漂移）。
      noToolRetries++;
      if (noToolRetries <= 2) {
        yield {
          type: "phase",
          phase: "analyze",
          label: "占卜师整理仪轨（未开牌，重新进入流程）…",
        };
        session.messages.push({
          role: "user",
          content: "⚠️ 你还没有抽取塔罗牌，不能直接给出解读。请立即调用工具：先 offer_card_selection 或 draw_cards 抽牌（若问题仍模糊可先 ask_user 澄清一次）。不要输出任何文本解释。",
        });
        continue;
      }
      // 两次纠偏仍不调工具：接受文本但标注（极小概率）
      const text = decision.message.content;
      if (text) {
        for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
          yield { type: "delta", delta: chunk };
        }
        db.updateSessionReading(session.id, text);
      }
      yield { type: "done" };
      session.finished = true;
      return;
    }
    noToolRetries = 0;

    // ⚠️ 一轮只执行一个工具调用
    // 真实占卜师的节奏是"做一个动作 → 看用户反应 → 再做下一个"。
    // 若一轮里执行多个 HITL 工具（如 3 个 interpret_card），
    // 用户会看到"问都没问就连续讲了三张牌"——退化成一次性生成。
    // 多余的 tool_calls 直接丢弃。提示信息写进**当前 tool 的返回内容**里
    // （不能插 user 消息：那会打断 assistant→tool 的配对，
    //  导致 OpenAI 兼容协议错位 "tool call result does not follow tool call"）。
    const extraTools = toolCalls.slice(1);
    // 记录待补齐的 tool_call（本轮结束后统一补响应，保持协议配对）
    pendingToolResponses = extraTools.map((t) => ({ id: t.id, name: t.function.name }));

    for (const tc of toolCalls.slice(0, 1)) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* 空参 */ }
      const t0 = Date.now();
      session.toolSeq++;
      const seq = session.toolSeq;
      // HITL 通用变量（承约/呼召/澄清/选牌/岔路共用）
      let askPrompt = "";
      let options: string[] | undefined;

      /* ---- D：收束 + 收尾追问 ---- */
      if (name === "close_reading") {
        const closing = String(args.closing || "").trim();
        const question = String(args.question || "这三段里，哪一段最贴近你现在的状态？").trim();
        let cOptions = Array.isArray(args.options)
          ? (args.options as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (cOptions.length < 2) {
          cOptions = session.drawnCards.map((d, i) => {
            const pos = session.drawnCards.length === 1 ? "核心指引" : (["过去", "当下", "未来"][i] ?? `第${i + 1}张`);
            return `${pos}那段`;
          });
        }
        // 收束语作为正文流出（先建目标条目再流 delta，前端按"收束"标签建命运之卷）
        yield { type: "phase", phase: "interpret", label: "占卜师收束这场占卜…" };
        if (closing) {
          for (const chunk of closing.match(/[\s\S]{1,6}/g) ?? []) {
            yield { type: "delta", delta: chunk };
          }
          yield { type: "delta", delta: "\n\n" };
        }
        yield { type: "phase", phase: "wait_user", label: "收束——听听你的回响…" };
        yield {
          type: "ask_user",
          ask: { question, options: cOptions, allowFree: true, prompt: question, kind: "closing" },
        };
        const answer = await new Promise<string>((resolve) => {
          session.pendingAsk = { resolve, question, options: cOptions, kind: "closing" };
        });
        session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ closing, question, userAnswer: answer }) });
        yield { type: "tool", tool: { name, args, resultSummary: `收束完成，用户回应：${answer.slice(0, 40)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `收束｜${answer.slice(0, 50)}`, Date.now() - t0);
        roundToolNames.push(name);
        // 收束完成 → 落库结束
        const finalReading = buildFinalReading(session);
        db.updateSessionReading(session.id, finalReading);
        // 审校结果（若已产生）一并落库
        const lastReview = (session as unknown as { __lastReview?: ReviewResult | null }).__lastReview ?? null;
        db.finishSession(session.id, lastReview);
        session.finished = true;
        yield { type: "done" };
        return;
      }

      /* ---- B1：逐张翻牌（念牌 + 确认问题）---- */
      if (name === "reveal_card") {
        const idx = Math.max(0, Math.min(Number(args.card_index) || 0, session.drawnCards.length - 1));
        const drawn = session.drawnCards[idx];
        if (!drawn) {
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "还没有抽牌" }) });
          continue;
        }
        const narrative = String(args.narrative || drawn.card.description || "").trim();
        const meaning = String(args.meaning || (drawn.reversed ? drawn.card.reversed : drawn.card.upright)).trim();
        const question = String(args.question || "这张牌对你来说，是什么意思？").trim();
        let qOptions = Array.isArray(args.options)
          ? (args.options as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (qOptions.length < 2) qOptions = ["是这样", "其实不太像", "我说不上来"];

        const posNames = ["过去", "当下", "未来"];
        const pos = session.drawnCards.length === 1 ? "核心指引" : (posNames[idx] ?? `第${idx + 1}张`);

        // 落库该张牌的"念牌"内容
        const slot = ensureCardSlot(session, idx);
        slot.reveal = { narrative, meaning, question, options: qOptions };
        slot.pos = pos;

        // 发翻牌事件（前端做 3D 翻牌动画 + 牌面叙述）
        yield {
          type: "card_reveal",
          cardReveal: {
            cardIndex: idx,
            total: session.drawnCards.length,
            id: drawn.card.id,
            nameZh: drawn.card.nameZh,
            image: drawn.card.image,
            reversed: drawn.reversed,
            pos,
            narrative,
            meaning,
          },
        };
        yield {
          type: "phase",
          phase: "wait_user",
          label: `翻到「${pos}·${drawn.card.nameZh}」，请占卜师与你说说话`,
        };
        // 提确认问题（这是 HITL：等用户回答）
        yield {
          type: "ask_user",
          ask: { question, options: qOptions, allowFree: true, prompt: question, kind: "card_confirm" },
        };
        const answer = await new Promise<string>((resolve) => {
          session.pendingAsk = { resolve, question, options: qOptions, kind: "card_confirm" };
        });
        slot.answer = answer;
        for (const tag of extractEmotionTags(answer)) {
          if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
        }
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            card: `${pos}·${drawn.card.nameZh}`,
            narrative, meaning, question,
            userAnswer: answer,
          }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `翻牌 ${pos}·${drawn.card.nameZh}，用户回应：${answer.slice(0, 40)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `翻牌 ${drawn.card.nameZh}｜回应：${answer.slice(0, 50)}`, Date.now() - t0);
        roundToolNames.push(name);
        continue;
      }

      /* ---- B2：讲透这一张牌 ---- */
      if (name === "interpret_card") {
        const idx = Math.max(0, Math.min(Number(args.card_index) || 0, session.drawnCards.length - 1));
        const text = String(args.reading || "").trim();
        if (!text) {
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "缺少 reading" }) });
          continue;
        }
        const slot = ensureCardSlot(session, idx);
        // ⚠️ 守卫：这张牌还没"翻"过（没有念牌 + 用户的确认回答）→ 不允许直接讲透。
        // 真实占卜师必须"翻一张、问一句、听回答、再讲"。模型偶尔会一口气
        // 调多个 interpret_card 跳过这个节奏（实测：3 张牌只翻了第 1 张）。
        if (!slot.reveal || !slot.answer) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: `第 ${idx + 1} 张牌尚未翻牌确认`,
              hint: `必须先调用 reveal_card(card_index=${idx}) 念牌并等待用户回答，才能 interpret_card。`,
            }),
          });
          roundToolNames.push(name);
          continue;
        }
        slot.reading = text;
        // 该牌解读作为正文流出（前端逐段显示）
        for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
          yield { type: "delta", delta: chunk };
        }
        yield { type: "delta", delta: "\n\n" };
        yield { type: "card_reading", cardReading: { cardIndex: idx, text } };
        session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ interpreted: slot.nameZh, text }) });
        yield { type: "tool", tool: { name, args, resultSummary: `解读 ${slot.nameZh}：${text.slice(0, 50)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `解读 ${slot.nameZh}`, Date.now() - t0);
        roundToolNames.push(name);

        // ---- 节奏交给用户（真实塔罗师讲完一张会停顿等你消化）----
        // 非最后一张牌：发"继续"型 HITL，前端渲染"翻下一张"按钮。
        // 用户点击（或插话）才 resume——占卜师不会自动连播。
        const isLast = idx >= session.drawnCards.length - 1;
        if (!isLast) {
          const nextPos = ["过去", "当下", "未来"][idx + 1] ?? `第${idx + 2}张`;
          yield { type: "phase", phase: "wait_user", label: `这张牌讲完了，等你准备好再翻下一张…` };
          yield {
            type: "ask_user",
            ask: {
              question: `「${slot.nameZh}」讲完了。准备好了就翻下一张（${nextPos}），或者先说点什么。`,
              options: ["翻下一张 →", "我有点想法…"],
              allowFree: true,
              prompt: "翻下一张",
              kind: "continue",
            },
          };
          const cont = await new Promise<string>((resolve) => {
            session.pendingAsk = { resolve, question: "继续", options: ["翻下一张 →"], kind: "continue" };
          });
          // 用户在停顿处插话（自由输入）→ 记录为插话，供下一张牌引用
          if (!/^(翻下一张|继续|好的?|嗯)/.test(cont.trim())) {
            session.interjections.push(cont.trim());
            session.messages.push({ role: "user", content: `（翻牌间隙补充：${cont.trim()}）` });
          } else {
            session.messages.push({ role: "user", content: "（继续翻下一张）" });
          }
        }
        continue;
      }

      /* ---- write_reading：子 Agent 管线 ---- */
      if (name === "write_reading") {
        // ⚠️ 守卫：逐张解读模式下，所有牌都讲完才允许进入最终综合。
        // 模型容易在讲完第 1 张后就调用 write_reading 提前收尾（实测：3 张牌只讲了 1 张）。
        // 这里拦住并明确告知还差哪几张，逼它继续 reveal_card/interpret_card。
        const total = session.drawnCards.length;
        const doneIdx = session.cardReadings
          .map((r, i) => ({ r, i }))
          .filter(({ r }) => r.reading)
          .map(({ i }) => i);
        if (total > 0 && doneIdx.length < total) {
          const missing = session.drawnCards
            .map((d, i) => ({ d, i }))
            .filter(({ i }) => !doneIdx.includes(i))
            .map(({ d, i }) => `第${i + 1}张「${d.card.nameZh}」`);
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "还有牌没讲完",
              missing,
              hint: `请先对 ${missing.join("、")} 依次调用 reveal_card（念牌+等用户回答）与 interpret_card（讲透这一张），全部讲完后才能调用 write_reading 做最终综合。`,
            }),
          });
          yield {
            type: "phase",
            phase: "interpret",
            label: `还有 ${missing.length} 张牌没讲——继续翻牌`,
          };
          roundToolNames.push("write_reading(拦截)");
          continue;
        }
        const focus = (args.focus as string) || "综合";
        yield { type: "phase", phase: "interpret", label: `子 Agent 管线启动（侧重：${focus}）…` };
        yield { type: "tool", tool: { name, args, resultSummary: "启动分析师→撰写者→审校者管线", durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, "启动管线", Date.now() - t0);

        // ① 分析师
        let notes = "";
        try {
          for await (const evt of runAnalyst(config, session)) {
            if (evt.type === "subagent" && evt.subagent?.detail) {
              db.logToolCall(session.id, seq, "analyst", "analyze", { cards: session.drawnCards.length }, evt.subagent.detail, 0);
            }
            yield evt;
          }
          notes = session.analystNotes;
        } catch (e) {
          yield { type: "error", error: `分析师异常：${e instanceof Error ? e.message : "未知"}` };
          db.failSession(session.id);
          return;
        }
        if (!notes) {
          yield { type: "error", error: "分析师未产出笔记" };
          return;
        }

        // ② 撰写者（初稿）
        // ⚠️ 逐张解读模式：正文已由 interpret_card 逐段生成并流给用户，
        //    这里**不再重写全文**（会与已流出的内容重复），只跑分析+审校。
        const perCardMode = session.cardReadings.some((r) => r.reading);
        let reading = "";
        if (perCardMode) {
          // 用已生成的逐张解读作为待审校正文
          reading = buildFinalReading(session);
          yield {
            type: "subagent",
            subagent: { agent: "writer", action: "逐张解读已就位，跳过重写", detail: `${reading.length} 字` },
          };
        } else {
          try {
            const gen = runWriter(config, session, focus);
            let first = true;
            while (true) {
              const { done, value } = await gen.next();
              if (done) break;
              if (first && value.type === "subagent") { first = false; }
              if (value.type === "delta") reading += value.delta;
              yield value;
            }
          } catch (e) {
            yield { type: "error", error: `撰写中断：${e instanceof Error ? e.message : "未知"}` };
            db.failSession(session.id);
            return;
          }
        }

        // ③ 审校者
        let review: ReviewResult | null = null;
        let revision = "";
        try {
          yield { type: "phase", phase: "review", label: "审校者正在检视解读…" };
          for await (const evt of runReviewer(config, session, reading)) {
            if (evt.type === "review") review = evt.review ?? null;
            yield evt;
          }
          revision = (session as unknown as { __revision?: string }).__revision ?? "";
        } catch {
          // 审校失败不阻断
        }

        // Reflexion：不过 → 重写一次 → 重新审校
        // ⚠️ 逐张模式不重写（正文已分段落给用户，重写会造成内容不一致），
        //    改为把审校意见作为提示，让后续 close_reading 收束时采纳。
        if (review && !review.pass && revision) {
          if (!perCardMode) {
            yield { type: "phase", phase: "interpret", label: "审校未通过 · 撰写者依据修改指令重写…" };
            db.updateSessionReading(session.id, reading); // 先存初稿
            try {
              reading = "";
              for await (const evt of runWriter(config, session, focus, revision)) {
                if (evt.type === "delta") reading += evt.delta;
                yield evt;
              }
              // 重写后再审校一次（判断新版是否达标，而非沿用旧结论）
              yield { type: "phase", phase: "review", label: "审校者复检重写稿…" };
              let reReview: ReviewResult | null = null;
              try {
                for await (const evt of runReviewer(config, session, reading)) {
                  if (evt.type === "review") reReview = evt.review ?? null;
                  yield evt;
                }
              } catch { /* 复检失败沿用原 review */ }
              if (reReview) review = reReview;
            } catch (e) {
              yield { type: "error", error: `重写中断：${e instanceof Error ? e.message : "未知"}` };
            }
          } else {
            // 逐张模式：把审校意见挂到 session，供收束阶段采纳
            (session as unknown as { __revision?: string }).__revision = revision;
            yield {
              type: "phase",
              phase: "review",
              label: "审校提出修改意见，将在收束时采纳",
            };
          }
        }

        db.updateSessionReading(session.id, reading);
        // 存审校结果（供 close_reading 收束时落库）
        (session as unknown as { __lastReview?: ReviewResult | null }).__lastReview = review;
        // ⚠️ 不在这里结束会话：逐张模式下还需要 close_reading 做收束
        // （收束语 + 一条行动建议 + 收尾追问）。
        // 旧流程（没有逐张解读）也走 close_reading，保证流程一致。
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            review: review ? { pass: review.pass, scores: review.scores } : null,
            revision: perCardMode ? "" : revision,
            note: "最终综合已完成。请接着调用 close_reading 做收束（收束语 + 一条行动建议 + 收尾追问）。",
          }),
        });
        roundToolNames.push(name);
        continue;
      }

      /* ---- 承约阶段（A1：问题重述确认）---- */
      if (name === "establish_contract") {
        const contractQ = String(args.question || session.question).trim();
        const scope = String(args.scope || "我看过去、现在，以及你正在犹豫的那条路").trim();
        session.contractQuestion = contractQ;
        session.scopeNote = scope;
        // 确认选项（模型可能漏传 → 通用兜底）
        let confirmOptions = Array.isArray(args.confirm_options)
          ? (args.confirm_options as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (confirmOptions.length < 2) confirmOptions = ["对，就是这个", "其实我想问点别的", "再具体一点"];
        askPrompt = contractQ;
        options = confirmOptions;        yield { type: "contract", contract: { question: contractQ, scope } };
        yield {
          type: "phase",
          phase: "wait_user",
          label: "占卜师复述问题，请你确认…",
        };
        yield {
          type: "ask_user",
          ask: {
            question: contractQ,
            options: confirmOptions,
            allowFree: true,
            prompt: contractQ,
            kind: "contract",
          },
        };
        const answer = await new Promise<string>((resolve) => {
          session.pendingAsk = { resolve, question: contractQ, options: confirmOptions, kind: "contract" };
        });
        for (const tag of extractEmotionTags(answer)) {
          if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
        }
        // 用户说"不是这个" → 用用户自己的话作为具体问题
        if (/^(不是|不对|其实|我想问|换)/.test(answer.trim()) && answer.length > 6) {
          session.contractQuestion = answer.trim();
        }
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ contract: session.contractQuestion, scope, userConfirmed: answer }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `承约确认：${session.contractQuestion}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `承约：${session.contractQuestion}`, Date.now() - t0);
        roundToolNames.push(name);
        continue;
      }

      /* ---- 呼召阶段（A3：三问呼召）---- */
      if (name === "invoke_three_questions") {
        let questions = Array.isArray(args.questions)
          ? (args.questions as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (questions.length < 3) {
          // 兜底：模型漏传或传少了 → 用通用三问
          questions = [
            `关于「${session.contractQuestion ?? session.question}」，你最想知道的答案是什么？`,
            "在这件事上，你已经打算做什么了？",
            "有什么是你担心发生、但还没真正面对的？",
          ];
        }
        questions = questions.slice(0, 3);
        session.invocation = { questions, answers: [] };
        yield { type: "invocation", invocation: { questions } };
        yield { type: "phase", phase: "wait_user", label: "呼召——请你回答三个问题…" };
        yield {
          type: "ask_user",
          ask: {
            question: questions.join("\n"),
            options: undefined,
            allowFree: true,
            prompt: questions.join("\n"),
            kind: "invocation",
          },
        };
        const answer = await new Promise<string>((resolve) => {
          session.pendingAsk = { resolve, question: questions.join("\n"), kind: "invocation" };
        });
        // 解析 "1. xxx\n2. xxx\n3. xxx" 形式的回答
        const answers = answer
          .split("\n")
          .map((l) => l.replace(/^\s*\d+[.、)]\s*/, "").trim())
          .filter((l) => l.length > 0);
        session.invocation = { questions, answers: answers.length ? answers : [answer] };
        for (const tag of extractEmotionTags(answer)) {
          if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
        }
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            invocation: questions.map((q, i) => ({ q, a: session.invocation?.answers[i] ?? "" })),
          }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `三问呼召：${session.invocation.answers.length} 个回答`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `呼召：${session.invocation.answers.join(" / ").slice(0, 80)}`, Date.now() - t0);
        roundToolNames.push(name);
        continue;
      }

      /* ---- HITL 工具（ask_user / offer_card_selection / fate_crossroads）---- */
      if (name === "ask_user" || name === "offer_card_selection" || name === "fate_crossroads") {
        let askEvent: AgentEvent;
        // askPrompt / options 已在工具循环顶部声明（承约与呼召分支共用）

        if (name === "ask_user") {
          const q = String(args.question || "请补充你的困惑");
          options = Array.isArray(args.options) ? (args.options as string[]).map(String) : undefined;
          askPrompt = q;
          askEvent = { type: "ask_user", ask: { question: q, options, allowFree: true, prompt: q } };
        } else if (name === "offer_card_selection") {
          const count = Math.min(Math.max(Number(args.count) || 3, 1), 5);
          askPrompt = `请凭直觉，从 ${count} 张牌中选出属于你的 ${count} 张命运之牌`;
          // 随机抽 7 张候选牌组成扇面（比全 78 张更聚焦，保留"直觉挑选"仪式感）
          const pool = [...TAROT_CARDS];
          const fanCards = Array.from({ length: Math.min(7, pool.length) }, () => {
            const idx = Math.floor(Math.random() * pool.length);
            const card = pool.splice(idx, 1)[0];
            return { id: card.id, nameZh: card.nameZh, image: card.image };
          });
          askEvent = {
            type: "ask_user",
            ask: { question: askPrompt, allowFree: false, prompt: askPrompt },
            fanCards,
            fanCount: count,
            // 选牌模式：额外标记，前端渲染扇面
          } as AgentEvent & { cardSelection?: boolean };
          (askEvent as AgentEvent & { cardSelection?: boolean }).cardSelection = true;
        } else {
          // fate_crossroads
          const prompt = String(args.prompt || "命运走到了岔路口");
          let branches = Array.isArray(args.branches)
            ? (args.branches as unknown[]).map(String).filter((b) => b.trim().length > 0)
            : [];
          // ⚠️ 兜底：模型偶尔只写 prompt 叙述而漏传 branches
          // （实测 DB 里出现过 branches(NOT ARRAY)）→ 前端 options 为空 + crossroads=true
          //    会导致"既没选项也没输入框"的彻底死锁。
          // 这里从 prompt 里抠出选项；抠不出就给通用选项，保证一定能继续。
          if (branches.length === 0) {
            branches = extractBranchesFromPrompt(prompt);
          }
          if (branches.length === 0) {
            branches = ["跟着直觉走", "稳妥为先", "先不决定，再想想"];
          }
          askPrompt = prompt;
          options = branches;
          askEvent = {
            type: "ask_user",
            ask: { question: prompt, options: branches, allowFree: true, prompt },
          };
          (askEvent as AgentEvent & { crossroads?: boolean }).crossroads = true;
        }

        yield { type: "phase", phase: "wait_user", label: "占卜师需要你的回应…" };
        yield askEvent;

        const userAnswer = await new Promise<string>((resolve) => {
          session.pendingAsk = { resolve, question: askPrompt, options };
        });

        let resultSummary = `用户回应：${userAnswer.slice(0, 60)}`;

        // offer_card_selection：解析选牌（格式 "牌id,牌id,牌id|犹豫ms,犹豫ms"；"random" 表示用户请求随机代抽）
        if (name === "offer_card_selection") {
          const drawn: DrawnCard[] = [];
          let dwell: number[] = [];
          if (userAnswer.trim() === "random") {
            // 兜底：前端未收到扇面数据时，用户可请求随机代抽
            const count = Math.min(Math.max(Number(args.count) || 3, 1), 5);
            const pool = [...TAROT_CARDS];
            for (let i = 0; i < count; i++) {
              const idx = Math.floor(Math.random() * pool.length);
              const card = pool.splice(idx, 1)[0];
              drawn.push({ card, reversed: Math.random() < 0.35 });
            }
          } else {
            const [idsStr, dwellStr] = userAnswer.split("|");
            const ids = idsStr.split(",").map((s) => s.trim()).filter(Boolean);
            dwell = (dwellStr ?? "").split(",").map((s) => parseInt(s, 10) || 0);
            ids.forEach((id) => {
              const card = getCardById(id);
              if (card) drawn.push({ card, reversed: Math.random() < 0.35 });
            });
          }
          session.drawnCards = drawn;
          // P1.3：犹豫时长结构化存入 session（供 writer prompt 引用："你在恋人牌前停留最久"）
          session.dwellTimes = userAnswer.trim() === "random"
            ? drawn.map(() => -1) // 随机代抽无犹豫数据
            : dwell;
          const posNames = ["过去", "当下", "未来"];
          const cards = drawn.map((d, i) => ({
            id: d.card.id, nameZh: d.card.nameZh, image: d.card.image,
            reversed: d.reversed, pos: drawn.length === 1 ? "核心指引" : posNames[i],
          }));
          db.updateSessionCards(session.id, cards);
          resultSummary = userAnswer.trim() === "random"
            ? `随机代抽：${cards.map((c) => `${c.pos}=${c.nameZh}${c.reversed ? "(逆位)" : ""}`).join("、")}`
            : `用户亲手选出：${cards.map((c) => `${c.pos}=${c.nameZh}${c.reversed ? "(逆位)" : ""}`).join("、")}；犹豫时长 ${dwell.join("/")}ms`;
          yield { type: "cards", cards };
        } else if (name === "fate_crossroads") {
          resultSummary = `用户选择走向：${userAnswer.slice(0, 60)}`;
        }

        session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ answer: userAnswer }) });
        // P2.1：情绪档案——从用户应答中提取情绪关键词，解读与追问持续引用
        // （占卜师"记得你说过很紧张"，而不是每次都当陌生人）
        for (const tag of extractEmotionTags(userAnswer)) {
          if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
        }
        yield { type: "tool", tool: { name, args, resultSummary, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, resultSummary, Date.now() - t0);
        yield { type: "phase", phase: "analyze", label: "已收到你的回应，占卜继续…" };
        roundToolNames.push(name);
        // 轮次时间轴（HITL 路径也要发）
        yield {
          type: "round",
          round: {
            round,
            elapsedMs: Date.now() - roundStart,
            promptTokens: roundPromptTokens,
            toolNames: roundToolNames,
            phase: name,
          },
        };
        continue;
      }

      /* ---- 普通工具（rag_search / draw_cards）---- */
      let resultSummary = "";
      let evExtra: Partial<AgentEvent> = {};
      let toolContent: string | undefined;

      if (name === "draw_cards") {
        const spread = (args.spread as string) || "three";
        const { summary, cards } = execDrawCards(spread, session);
        resultSummary = summary;
        evExtra = { cards };
        yield { type: "phase", phase: "draw", label: `命运之牌已抽出（${spread === "single" ? "单张聚焦" : "三张时间流"}）` };
      } else if (name === "rag_search") {
        const q = String(args.query || "");
        const topK = Number(args.top_k) || 5;
        const { summary, currentHits, allHits } = await execRagSearch(q, topK, session);
        resultSummary = summary;
        // 前端知识面板拿到**累计命中**（与解读 [n] 编号一致）
        evExtra = { ragHits: allHits };
        yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${q.slice(0, 16)}」` };
        // 独立 rag_hits 事件：前端 KnowledgePanel 与外部集成方都依赖此事件
        // （tool 事件内嵌的 ragHits 仅作为冗余）
        if (allHits.length > 0) yield { type: "rag_hits", ragHits: allHits };
        // 回填给 LLM 的观察结果用**压缩版**（只含本次命中的相对编号，省 30-40% token）
        toolContent = compressRagResult(currentHits);
      } else {
        resultSummary = `未知工具：${name}`;
      }

      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolContent ?? JSON.stringify({ result: resultSummary }),
      });
      yield { type: "tool", tool: { name, args, resultSummary, durationMs: Date.now() - t0 }, ...evExtra };
      db.logToolCall(session.id, seq, "supervisor", name, args, resultSummary, Date.now() - t0);
      roundToolNames.push(name);
    }

    // ---- 轮次结束：发时间轴事件（前端可视化"Agent 在哪一步慢"）----
    yield {
      type: "round",
      round: {
        round,
        elapsedMs: Date.now() - roundStart,
        promptTokens: roundPromptTokens,
        toolNames: roundToolNames,
        phase: roundToolNames.length ? roundToolNames[roundToolNames.length - 1] : "decide",
      },
    };
  }

  yield { type: "error", error: "占卜师陷入沉思无法自拔…（达到最大轮次）" };
  db.failSession(session.id, "max_rounds");
  } finally {
    // 退出路径统一补齐 tool_call 响应（保持协议配对）
    flushPendingToolResponses();
  }
}

/* ------------------------------------------------------------------ */
/* 无 Key 降级：剧本式模拟                                              */
/* ------------------------------------------------------------------ */

async function* runLocalFallback(session: AgentSession, question: string): AsyncGenerator<AgentEvent> {
  yield { type: "phase", phase: "analyze", label: "（本地引擎）分析问题领域…" };
  await sleep(500);

  const domainHint = /爱|恋|婚|感情|复合|桃花|他|她|喜欢/.test(question) ? "情感"
    : /工作|事业|职场|跳槽|升职|求职/.test(question) ? "事业"
    : /钱|财|投资|理财/.test(question) ? "财富" : "综合";

  // 模拟澄清
  yield { type: "phase", phase: "wait_user", label: "占卜师需要你的回应…" };
  yield {
    type: "ask_user",
    ask: { question: `关于「${question}」，你更想了解哪方面？`, options: ["原因与现状", "未来走向", "行动建议"], allowFree: true, prompt: `关于「${question}」，你更想了解哪方面？` },
  };
  const answer = await new Promise<string>((resolve) => {
    session.pendingAsk = { resolve, question: `关于「${question}」，你更想了解哪方面？`, options: ["原因与现状", "未来走向", "行动建议"] };
  });

  // 模拟抽牌
  const spread = domainHint === "综合" ? "single" : "three";
  const { summary, cards } = execDrawCards(spread, session);
  yield { type: "phase", phase: "draw", label: `命运之牌已抽出（${spread === "single" ? "单张聚焦" : "三张时间流"}）` };
  yield { type: "cards", cards };
  yield { type: "tool", tool: { name: "draw_cards", args: { spread }, resultSummary: summary, durationMs: 120 } };

  // 模拟 RAG
  await sleep(400);
  const { summary: ragSummary, allHits } = await execRagSearch(question + " " + cards.map((c) => c.nameZh).join(" "), 5, session);
  yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${question.slice(0, 12)}…」` };
  yield { type: "rag_hits", ragHits: allHits };
  yield { type: "tool", tool: { name: "rag_search", args: { query: question.slice(0, 20) }, resultSummary: ragSummary, durationMs: 80 } };

  // 模拟子 Agent
  yield { type: "subagent", subagent: { agent: "analyst", action: "分析完成（本地）" } };
  yield { type: "subagent", subagent: { agent: "writer", action: "初稿完成（本地）" } };

  const text = localInterpret(question, session.drawnCards, domainHint, answer);
  yield { type: "phase", phase: "interpret", label: "占卜师正在撰写命运之卷…" };
  for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
    yield { type: "delta", delta: chunk };
    await sleep(16);
  }

  yield { type: "review", review: { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "本地引擎：审校通过" } };
  yield { type: "subagent", subagent: { agent: "reviewer", action: "审校通过（本地）" } };

  db.updateSessionReading(session.id, text);
  db.finishSession(session.id, { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "本地引擎" });
  session.finished = true;
  yield { type: "done" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function localInterpret(question: string, cards: DrawnCard[], domain: string, userAnswer: string): string {
  const posNames = ["过去之源", "当下之境", "未来之势"];
  const lines: string[] = [];
  lines.push("星辰已各就其位，让我为你展开命运的密语。");
  lines.push("");
  lines.push(`你问及「${question}」（${domain}之问），并言明更想了解「${userAnswer}」。`);
  lines.push("");
  cards.forEach((d, i) => {
    const { card, reversed } = d;
    const meaning = reversed ? card.reversed : card.upright;
    const pos = cards.length === 1 ? "核心指引" : posNames[i];
    lines.push(`◈ ${pos} · ${card.nameZh}${reversed ? "（逆位）" : "（正位）"}`);
    lines.push(`  ${card.element}之牌。典籍有云：${meaning}。`);
    lines.push(`  ${reversed ? "能量受阻，需要反观自照" : "能量流畅，顺势可为"}。`);
    lines.push("");
  });
  const kw = cards.flatMap((d) => d.card.keywords).slice(0, 6);
  lines.push("◈ 综合启示");
  lines.push(`  关键词汇聚：${kw.join("、")}。`);
  lines.push(`  你所求的「${userAnswer}」，牌面提示：既需倾听内心，也需勇敢行动。`);
  lines.push("");
  lines.push("愿星辰指引你的路。✨");
  return lines.join("\n");
}

export { getCardById, TAROT_CARDS };
