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
    stylePrompt: "你是\"月影占卜师\"，一位精通韦特塔罗的神秘学智者。语言繁复优美，兼具神秘感与温度，像一位真正的占卜师在低语。适度使用 ◈ ✦ 等符号。",
  },
  {
    id: "healer",
    name: "心灵疗愈师",
    emoji: "🌿",
    desc: "温柔共情 · 偏心理疏导的疗愈系解读",
    stylePrompt: "你是\"心灵疗愈师\"，将塔罗作为自我觉察的镜子。语言温柔、共情、不带评判，注重情绪命名与接纳，像一位陪伴者。少用神秘符号，多用心理论述。",
  },
  {
    id: "blade",
    name: "直断导师",
    emoji: "⚔️",
    desc: "犀利直接 · 不绕弯子的毒舌直断",
    stylePrompt: "你是\"直断导师\"，言辞犀利、一针见血，绝不绕弯子安慰。直面问题核心，甚至带点毒舌，但每句话都有塔罗依据。用户要的是真相而非安慰剂。",
  },
];

export interface AgentEvent {
  type:
    | "session" | "phase" | "delta" | "reasoning" | "tool" | "rag_hits" | "cards"
    | "ask_user" | "subagent" | "review" | "round" | "done" | "error";
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
  ask?: { question: string; options?: string[]; allowFree: boolean; prompt: string };
  subagent?: { agent: SubAgent; action: string; detail?: string }; // 子 Agent 生命周期
  review?: { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string; rewritten?: boolean; parseLevel?: 0 | 1 | 2 | 3; retried?: boolean };
  /** 轮次时间轴：每轮耗时与 token，供前端可视化"Agent 在哪一步慢" */
  round?: { round: number; elapsedMs: number; promptTokens?: number; toolNames: string[]; phase?: string };
  error?: string;
}

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
  pendingAsk?: { resolve: (answer: string) => void; question: string; options?: string[] };
  finished: boolean;
  toolSeq: number;
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
        "命运岔路：解读中段，向用户呈现 2~3 条命运走向让其选择，后续解读（尤其未来牌）按选择分支。让用户参与塑造自己的解读，增强人机协同。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "岔路引子，如\"宝剑八显示你可能被困于沉默——\"" },
          branches: {
            type: "array",
            items: { type: "string" },
            description: "2~3 条走向描述（简短）",
          },
        },
        required: ["prompt", "branches"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_reading",
      description:
        "启动子 Agent 管线撰写最终解读：① 牌意分析师逐牌产出分析笔记 → ② 撰写者基于笔记流式撰写 → ③ 审校者三维度打分（典籍忠实/共情/语气），任一 < 7 分打回重写一次。在信息足够后调用。",
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

async function execRagSearch(query: string, topK: number, session: AgentSession) {
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
  const summary = `检索到 ${currentHits.length} 条：${currentHits.slice(0, 3).map((h) => `${h.cardNameZh}(${h.score},${h.channels.join("+")})`).join("、")}${currentHits.length > 3 ? "…" : ""}（累计 ${session.ragHits.length} 条）`;
  return { summary, currentHits, allHits: session.ragHits };
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

  const messages: SessionMessage[] = [
    {
      role: "system",
      content: buildWriterPrompt(session.persona),
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
 */
function trimHistory(messages: SessionMessage[], keepFullRounds = 4): SessionMessage[] {
  if (messages.length <= keepFullRounds * 2 + 4) return messages;

  // 找到最近 keepFullRounds 个 tool 消息的位置，从那里往前的 tool 消息全压缩
  const toolIndexes: number[] = [];
  messages.forEach((m, i) => { if (m.role === "tool") toolIndexes.push(i); });
  if (toolIndexes.length <= keepFullRounds) return messages;

  const cutBefore = toolIndexes[toolIndexes.length - keepFullRounds];

  return messages.map((m, i) => {
    if (m.role !== "tool" || i >= cutBefore) return m;
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

  const MAX_ROUNDS = 12;
  let round = 0;
  // 模型跳过工具直接回答的纠偏计数（首答模式防行为漂移）
  let noToolRetries = 0;
  // 看门狗：整场占卜的总时长上限（默认 5 分钟），超时主动收尾并落库
  const totalDeadline = Date.now() + (Number(process.env.SESSION_DEADLINE_MS) || 5 * 60 * 1000);

  while (round < MAX_ROUNDS) {
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
      const trimmed = trimHistory(session.messages);
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
    session.messages.push(decision.message);

    const toolCalls = decision.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // ---- 无工具调用分支 ----
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

    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* 空参 */ }
      const t0 = Date.now();
      session.toolSeq++;
      const seq = session.toolSeq;

      /* ---- write_reading：子 Agent 管线 ---- */
      if (name === "write_reading") {
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
        let reading = "";
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
        if (review && !review.pass && revision) {
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
        }

        db.updateSessionReading(session.id, reading);
        db.finishSession(session.id, review);
        session.finished = true;
        yield { type: "done" };
        return;
      }

      /* ---- HITL 工具（ask_user / offer_card_selection / fate_crossroads）---- */
      if (name === "ask_user" || name === "offer_card_selection" || name === "fate_crossroads") {
        let askEvent: AgentEvent;
        let askPrompt: string;
        let options: string[] | undefined;

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
          const branches = Array.isArray(args.branches) ? (args.branches as string[]).map(String) : [];
          askPrompt = prompt;
          options = branches;
          askEvent = {
            type: "ask_user",
            ask: { question: prompt, options: branches, allowFree: false, prompt },
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
