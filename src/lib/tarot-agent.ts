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
    | "ask_user" | "subagent" | "review" | "done" | "error";
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
  review?: { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string; rewritten?: boolean };
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
  buildProviders, pickProvider, markFailed, markHealthy, isFailoverError,
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
  return {
    message: {
      role: "assistant",
      content: choice?.message?.content ?? "",
      tool_calls: choice?.message?.tool_calls,
    },
    reasoning: choice?.message?.reasoning_content,
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
        max_tokens: 6000,
        thinking: { type: "disabled" },
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
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 流中断：若已有输出则放弃（不切避免重复推送）；无输出则可重试
      db.logLLMUsage(sessionId ?? null, agent, p.name, 0, totalChars, Date.now() - t0, totalChars === 0);
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
        db.logLLMUsage(sessionId ?? null, agent, p.name, 0, totalChars, Date.now() - t0, true);
        markHealthy(p);
        return "ok";
      }
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) { totalChars += delta.content.length; yield delta.content as string; }
      } catch { /* 忽略 */ }
    }
  }
  db.logLLMUsage(sessionId ?? null, agent, p.name, 0, totalChars, Date.now() - t0, true);
  markHealthy(p);
  return "ok";
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
        "混合检索塔罗典籍知识库（BM25+向量 RRF 融合，78 张韦特牌）。当需要了解某张牌的详细牌意、或按主题查找相关牌时调用。返回带相关度分数与命中通道的知识片段。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词，如牌名、主题关键词（如\"复合 感情\"）" },
          top_k: { type: "number", description: "返回条数，默认 5" },
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
  const hits = await hybridSearch(query, k);
  session.ragHits = hits;
  const summary = hits.length
    ? `检索到 ${hits.length} 条：${hits.slice(0, 3).map((h) => `${h.cardNameZh}(${h.score},${h.channels.join("+")})`).join("、")}${hits.length > 3 ? "…" : ""}`
    : "无相关命中";
  return { summary, hits };
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
      content: `你是塔罗牌意分析师（analyst），职责是产出**精简**的结构化分析笔记供撰写者使用，不面向用户，不需要文采。
⚠️ 严格控制篇幅：每张牌 3 行以内，全文不超过 400 字。简洁信息密度高，勿展开长篇论述。

输出格式（每张牌一段）：
【位置 · 牌名（正/逆位）】
- 典籍：<引用牌面知识/RAG 原文，标注 [n] 编号>
- 位置动力学：<1 句>
- 与问题的关联：<1 句>

最后一行【整体叙事】：三张牌连成的一句话故事（1 句）。`,
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

  const res = await callLLM(config, messages, undefined, session.id, "analyst");
  if (res.reasoning) yield { type: "reasoning", reasoning: `[分析师] ${res.reasoning}` };
  session.analystNotes = res.message.content;
  yield {
    type: "subagent",
    subagent: { agent: "analyst", action: "分析完成", detail: `笔记 ${res.message.content.length} 字` },
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
      content: `${session.persona.stylePrompt}

你是占卜解读的撰写者（writer），基于分析师的结构化笔记撰写面向用户的最终解读。
要求：
1. 引用典籍牌意时用「典籍有云：…」标注，并标注 [n] 编号对应检索结果
2. 逐牌解读（过去/当下/未来 或 单张核心指引），再给综合启示与可执行建议
3. 结合用户问题与澄清回答，针对性展开
4. **篇幅 350~450 字**，分段清晰，直接输出正文不加任何前言
5. 不要复述分析师笔记的格式，要写成流畅的占卜文本`,
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

/** ③ 审校者：三维度打分 + Reflexion 修改指令 */
async function* runReviewer(
  config: LLMProvider | null, session: AgentSession, reading: string
): AsyncGenerator<AgentEvent, { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string }> {
  yield { type: "subagent", subagent: { agent: "reviewer", action: "审校中（典籍忠实/共情/语气）" } };

  // 典籍依据 = RAG 检索结果 + 用户抽到/选中的牌面知识（两者都是合法引用来源）
  const ragContext = session.ragHits.length
    ? session.ragHits.map((h, i) => `[${i + 1}] ${h.source}\n    ${h.snippet}`).join("\n")
    : "（未检索）";
  const cardNames = session.drawnCards.map((d) => d.card.nameZh).join("、");

  const messages: SessionMessage[] = [
    {
      role: "system",
      content: `你是占卜解读的审校者（reviewer）。从三个维度为解读打分（0~10 整数）：
- grounding 典籍忠实：解读引用的牌意是否**有据可依**——合法来源包括①下方"牌面知识"（用户抽到的牌，牌意原文可信）②下方"RAG 检索结果"。仅当引用了**既不在牌面知识、也不在检索结果**的牌意才算编造。
- empathy 共情：是否回应用户的具体问题与澄清回答，有无针对性
- tone 语气：是否符合占卜师人格（${session.persona.name}），文风是否统一

【重要】不要苛求每张抽到的牌都必须出现在 RAG 检索里——牌面知识本身就是典籍原文。
只有在解读**编造了牌面知识与检索结果中都不存在的牌意**时才给 grounding 低分。

严格 JSON 输出（不要 markdown 代码块）：
{"pass": <grounding>=7 且 empathy>=6 且 tone>=6>, "scores": {"grounding": n, "empathy": n, "tone": n}, "comment": "一句话总评", "revision": "<若不通过，给撰写者的具体修改指令；通过则为空字符串>"}`,
    },
    {
      role: "user",
      content: `用户问题：${session.question}
占卜师人格：${session.persona.name}（${session.persona.desc}）
用户抽到的牌：${cardNames}

【牌面知识】（合法引用来源，牌意原文）
${buildCardKnowledge(session.drawnCards)}

RAG 检索结果（另一合法引用来源）：
${ragContext}

待审校解读：
${reading}

请审校。`,
    },
  ];

  const res = await callLLM(config, messages, undefined, session.id, "reviewer");
  let parsed: { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string; revision?: string };
  try {
    const m = res.message.content.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "审校解析失败，默认通过" };
  } catch {
    parsed = { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "审校解析失败，默认通过" };
  }

  const result = {
    pass: parsed.pass && parsed.scores.grounding >= 6 && parsed.scores.empathy >= 6 && parsed.scores.tone >= 6,
    scores: parsed.scores,
    comment: parsed.comment ?? "",
  };

  yield { type: "review", review: { ...result } };
  yield {
    type: "subagent",
    subagent: {
      agent: "reviewer",
      action: result.pass ? "审校通过" : "退回重写",
      detail: `grounding=${result.scores.grounding} empathy=${result.scores.empathy} tone=${result.scores.tone}`,
    },
  };

  // 存 revision 供 supervisor 决定是否重写
  (session as unknown as { __revision?: string }).__revision = result.pass ? "" : (parsed.revision ?? "请全面修改");
  return result;
}

/* ------------------------------------------------------------------ */
/* 主流程：Supervisor 循环                                              */
/* ------------------------------------------------------------------ */

function buildSystemPrompt(session: AgentSession): string {
  return `${session.persona.stylePrompt}

你是这场占卜的 Supervisor（编排者），通过工具调用推进占卜流程。

【工作流程】
1. 问题模糊 → ask_user 澄清（全程最多 2 次，每次 1 个问题）
2. 选牌：优先 offer_card_selection 请用户亲手选牌（体验最佳）；用户没耐心/问题简单也可 draw_cards 随机
3. 对抽到的牌调用 rag_search 查阅典籍（可合并查询）
4. 若用户处境存在明显岔路 → fate_crossroads 让用户选走向
5. 信息足够 → write_reading 启动子 Agent 管线（分析师→撰写者→审校者，审校不过自动重写一次）

【纪律】
- ask_user 全程最多 2 次
- write_reading 只调用一次（重写由管线内部处理，不需要你再调）
- rag_search 按需调用，不必过度检索`;
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
  } else if (opts?.followup) {
    session.messages.push({ role: "user", content: `（追问）${opts.followup}` });
    session.messages.push({
      role: "system",
      content: "用户在追问。请基于已有牌面与上下文直接回答（可以正常说话，不必调用工具），300 字以内。若确需补充检索可调一次 rag_search。",
    });
  }

  yield { type: "phase", phase: "analyze", label: `${session.persona.emoji} ${session.persona.name}开始凝听你的问题…` };

  const MAX_ROUNDS = 12;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    let decision: CallResult;
    try {
      decision = await callLLM(config, session.messages, TOOLS, session.id, "supervisor");
      // failover 生效时更新会话粘住的 provider（保持后续风格一致）——按名称比较，避免对象实例误判
      const used = buildProviders().find((p) => p.name === decision.provider);
      if (used && used.name !== config?.name) {
        config = used;
        (session as unknown as { __provider?: LLMProvider }).__provider = used;
        yield { type: "phase", phase: "analyze", label: `主模型连接不畅，已切换备用模型（${used.name}）` };
      }
    } catch (e) {
      yield { type: "error", error: `占卜师暂时失联：${e instanceof Error ? e.message : "未知错误"}` };
      db.failSession(session.id);
      return;
    }
    if (decision.reasoning) yield { type: "reasoning", reasoning: decision.reasoning };
    session.messages.push(decision.message);

    const toolCalls = decision.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // 直接文本回答（追问模式的正常路径）
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
        let review: { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string } | null = null;
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
            let reReview: { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string } | null = null;
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
        continue;
      }

      /* ---- 普通工具（rag_search / draw_cards）---- */
      let resultSummary = "";
      let evExtra: Partial<AgentEvent> = {};

      if (name === "draw_cards") {
        const spread = (args.spread as string) || "three";
        const { summary, cards } = execDrawCards(spread, session);
        resultSummary = summary;
        evExtra = { cards };
        yield { type: "phase", phase: "draw", label: `命运之牌已抽出（${spread === "single" ? "单张聚焦" : "三张时间流"}）` };
      } else if (name === "rag_search") {
        const q = String(args.query || "");
        const topK = Number(args.top_k) || 5;
        const { summary, hits } = await execRagSearch(q, topK, session);
        resultSummary = summary;
        evExtra = { ragHits: hits };
        yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${q.slice(0, 16)}」` };
      } else {
        resultSummary = `未知工具：${name}`;
      }

      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({ result: resultSummary }),
      });
      yield { type: "tool", tool: { name, args, resultSummary, durationMs: Date.now() - t0 }, ...evExtra };
      db.logToolCall(session.id, seq, "supervisor", name, args, resultSummary, Date.now() - t0);
    }
  }

  yield { type: "error", error: "占卜师陷入沉思无法自拔…（达到最大轮次）" };
  db.failSession(session.id);
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
  const { summary: ragSummary, hits } = await execRagSearch(question + " " + cards.map((c) => c.nameZh).join(" "), 5, session);
  yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${question.slice(0, 12)}…」` };
  yield { type: "rag_hits", ragHits: hits };
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
