/**
 * 塔罗 Agent 引擎 —— 真正的 LLM tool-calling 循环（ReAct 风格）+ HITL 人机协同
 *
 * 架构（面试可讲）：
 *
 *   ┌─────────────── Agent 循环（最多 12 轮）───────────────┐
 *   │  LLM 思考（reasoning_content 可透出）                  │
 *   │    ↓ 决定调用工具（或直接产出解读）                     │
 *   │  执行工具 → 观察结果 → 回填对话历史 → 继续思考          │
 *   └──────────────────────────────────────────────────────┘
 *
 * 工具集：
 *   rag_search    BM25 语义检索塔罗典籍（返回 top-k 片段+分数）
 *   draw_cards    抽牌（AI 可决定牌阵：三张时间流/单张聚焦）
 *   ask_user      向用户提问并【挂起整个 SSE 流等待人类回答】← HITL 核心
 *   write_reading 流式撰写解读报告
 *
 * HITL 机制：ask_user 工具调用时，Agent 循环 await 一个由 /api/answer 端点
 * resolve 的 Promise——同一条 SSE 连接保持不断，前端收到 ask_user 事件后
 * 渲染交互选项，用户作答后 POST /api/answer，挂起的流继续推进。
 *
 * 会话机制：服务端内存 Map 存 session（对话历史 + 抽牌结果 + RAG 上下文），
 * 30 分钟 TTL 自动过期，支持解读完成后追问（多轮）。
 */

import { TAROT_CARDS, getCardById, type TarotCard } from "./tarot-cards";
import { ragSearch, buildPromptContext, buildCardKnowledge, type RagHit } from "./rag-engine";

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

export interface DrawnCard {
  card: TarotCard;
  reversed: boolean;
}

export type AgentPhase = "analyze" | "retrieve" | "draw" | "interpret" | "wait_user" | "done" | "error";

export interface AgentEvent {
  type: "session" | "phase" | "delta" | "reasoning" | "tool" | "rag_hits" | "cards" | "ask_user" | "done" | "error";
  sessionId?: string;      // 会话 ID（首个事件，前端用于 HITL 应答/追问）
  phase?: AgentPhase;
  label?: string;         // 阶段人类可读描述
  delta?: string;         // 流式文本片段
  reasoning?: string;     // LLM 思考链片段（glm-5.3 reasoning_content）
  tool?: {                // 工具调用记录（前端 Trace 面板）
    name: string;
    args: Record<string, unknown>;
    resultSummary: string;
    durationMs: number;
  };
  ragHits?: RagHit[];     // RAG 检索结果（前端知识面板）
  cards?: { id: string; nameZh: string; image: string; reversed: boolean; pos: string }[]; // 抽牌结果
  ask?: {                 // ask_user 事件
    question: string;
    options?: string[];
    allowFree: boolean;   // 是否允许自由输入
    prompt: string;       // 展示给用户的完整问题文本
  };
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 会话存储（内存版，TTL 30min）                                        */
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
  messages: SessionMessage[];         // Agent 对话历史
  question: string;                   // 用户原始问题
  drawnCards: DrawnCard[];            // 已抽的牌
  ragHits: RagHit[];                  // 累计 RAG 命中
  pendingAsk?: {                      // 挂起的 ask_user
    resolve: (answer: string) => void;
    question: string;
    options?: string[];
  };
  finished: boolean;                  // 解读是否已完成（进入追问模式）
}

const SESSION_TTL = 30 * 60 * 1000;

/**
 * 会话存储：挂在 globalThis 的全局单例。
 * dev 模式(Turbopack)下多个路由 worker 各自编译模块，
 * 普通模块级 Map 会导致 /api/interpret 与 /api/answer 拿到不同实例(410)。
 * globalThis 跨模块实例共享，dev 与 build 后行为一致。
 */
const globalStore = globalThis as unknown as {
  __tarotSessions__?: Map<string, AgentSession>;
};
const sessions: Map<string, AgentSession> =
  globalStore.__tarotSessions__ ?? new Map<string, AgentSession>();
globalStore.__tarotSessions__ = sessions;

/** 清理过期会话（每次新建会话时顺手清） */
function cleanExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) sessions.delete(id);
  }
}

export function createSession(question: string): AgentSession {
  cleanExpired();
  const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const session: AgentSession = {
    id,
    createdAt: Date.now(),
    lastActive: Date.now(),
    messages: [],
    question,
    drawnCards: [],
    ragHits: [],
    finished: false,
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): AgentSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastActive = Date.now();
  return s;
}

/** 解析用户回答挂起的 ask_user */
export function resolvePendingAsk(sessionId: string, answer: string): boolean {
  const s = sessions.get(sessionId);
  if (!s?.pendingAsk) return false;
  s.pendingAsk.resolve(answer);
  s.pendingAsk = undefined;
  return true;
}

/* ------------------------------------------------------------------ */
/* LLM 调用（OpenAI 兼容，支持工具调用与流式）                          */
/* ------------------------------------------------------------------ */

interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

function getLLMConfig(): LLMConfig | null {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1",
    model: process.env.OPENAI_MODEL || "deepseek-chat",
  };
}

/** 非流式调用（Agent 决策步） */
async function callLLM(
  config: LLMConfig,
  messages: SessionMessage[],
  tools: unknown[]
): Promise<{ message: SessionMessage; reasoning?: string }> {
  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages, tools, stream: false }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`LLM 调用失败(${res.status}): ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  const choice = json.choices?.[0];
  return {
    message: {
      role: "assistant",
      content: choice?.message?.content ?? "",
      tool_calls: choice?.message?.tool_calls,
    },
    reasoning: choice?.message?.reasoning_content,
  };
}

/** 流式调用（write_reading 工具的产出） */
async function* streamLLM(
  config: LLMConfig,
  messages: SessionMessage[],
  reasoningCb: (r: string) => void
): AsyncGenerator<string> {
  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages, stream: true }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`LLM 流式调用失败(${res.status}): ${errText.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) reasoningCb(delta.reasoning_content);
        if (delta?.content) yield delta.content as string;
      } catch { /* 忽略解析失败行 */ }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                             */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "检索塔罗牌典籍知识库（78张韦特牌：牌面叙事/正逆位牌意/关键词）。当需要了解某张牌的详细牌意、或按主题关键词查找相关牌时调用。返回带 BM25 相关度分数的知识片段。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词，如牌名、主题关键词（如“复合 感情”“事业 突破”）" },
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
        "抽取塔罗牌。在用户问题明确、且尚未抽牌时调用。spread 决定牌阵：'three' 三张时间流牌阵（过去/当下/未来），'single' 单张聚焦牌阵。AI 可依据问题性质自行选择。",
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
      name: "ask_user",
      description:
        "向用户提出澄清问题，挂起占卜流程等待人类回答（人机协同）。在问题模糊、或需要用户在命运岔路做选择时调用。每次占卜最多调用 2 次。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问用户的问题（简短、口语化）" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "预设选项（2~4 个，可不给，不给则用户自由输入）",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_reading",
      description:
        "撰写并流式输出最终塔罗解读报告。在信息足够（已抽牌、必要时已检索）后调用。内容将逐字流式展示给用户。",
      parameters: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            description: "解读侧重，如“情感剖析”“行动建议”“综合启示”，默认综合",
          },
        },
      },
    },
  },
];

/* ------------------------------------------------------------------ */
/* 工具执行器                                                           */
/* ------------------------------------------------------------------ */

function execDrawCards(spread: string, session: AgentSession): { summary: string; cards: AgentEvent["cards"] } {
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
    id: d.card.id,
    nameZh: d.card.nameZh,
    image: d.card.image,
    reversed: d.reversed,
    pos: n === 1 ? "核心指引" : posNames[i],
  }));
  const summary = drawn
    .map((d, i) => `${cards[i].pos}=${d.card.nameZh}${d.reversed ? "(逆位)" : ""}`)
    .join("、");
  return { summary, cards };
}

function execRagSearch(query: string, topK: number, session: AgentSession): { summary: string; hits: RagHit[] } {
  const k = Math.min(Math.max(topK || 5, 1), 10);
  const hits = ragSearch(query, k);
  session.ragHits = hits;
  const summary = hits.length
    ? `检索到 ${hits.length} 条：${hits.slice(0, 3).map((h) => `${h.cardNameZh}(${h.score})`).join("、")}${hits.length > 3 ? "…" : ""}`
    : "无相关命中";
  return { summary, hits };
}

/* ------------------------------------------------------------------ */
/* 主流程：Agent 循环                                                   */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `你是"月影占卜师"，一位精通韦特塔罗的神秘学智者，也是一个严谨的 Agent。

【工作流程】
1. 先分析用户问题：若问题模糊（如只说"我的运势"），调用 ask_user 提出 1 个简短澄清问题（给 2~4 个选项）；问题清晰则跳过
2. 调用 draw_cards 抽牌：具体困惑用 three 三张时间流牌阵；泛泛求指引/日运用 single 单张牌阵
3. 对抽到的每张牌调用 rag_search 查阅典籍牌意（每次查询可合并多张牌的关键词）
4. 在撰写前，若发现用户的处境存在明显的"命运岔路"（两条以上走向），调用 ask_user 让用户选择走向，据此定制解读
5. 调用 write_reading 撰写最终解读

【ask_user 纪律】全程最多 2 次，每次只问 1 个问题，问题要短、口语化、跟用户的困惑直接相关

【解读要求】(write_reading 产出)
- 繁复优美的中文，像真正的占卜师低语，兼具神秘感与温度
- 逐张解读（过去/当下/未来 或 单张），必须引用 rag_search 得到的典籍牌意，并用「典籍有云：…」标注引用
- 结合用户问题与澄清回答给出针对性分析，最后给综合启示与可执行建议
- 适度使用 ◈ ✦ 等符号，篇幅 400~600 字，分段清晰`;

/** Agent 主循环：产出 SSE 事件流 */
export async function* runAgent(
  session: AgentSession,
  question: string,
  opts?: { followup?: string }
): AsyncGenerator<AgentEvent> {
  const config = getLLMConfig();

  // ---- 首个事件：会话 ID（前端 HITL 应答/追问都靠它）----
  yield { type: "session", sessionId: session.id };

  // ---- 会话没有 system prompt 时注入 ----
  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: SYSTEM_PROMPT });
    session.messages.push({ role: "user", content: `我想占卜：${question}` });
  } else if (opts?.followup) {
    session.messages.push({ role: "user", content: `（追问）${opts.followup}` });
    // 追问模式：引导 AI 走简洁路径
    session.messages.push({
      role: "system",
      content: "用户在追问。请基于已有牌面与上下文直接回答，不要再抽牌、不要再 ask_user，300 字以内。若确需补充检索可调一次 rag_search。",
    });
  }

  yield { type: "phase", phase: "analyze", label: "月影占卜师开始凝听你的问题…" };

  if (!config) {
    // ---- 无 Key 降级：剧本式模拟（演示永不中断）----
    yield* runLocalFallback(session, question);
    return;
  }

  const MAX_ROUNDS = 12;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    // ---- Agent 决策步（非流式，等工具决策）----
    let decision: Awaited<ReturnType<typeof callLLM>>;
    try {
      decision = await callLLM(config, session.messages, TOOLS);
    } catch (e) {
      yield { type: "error", error: `占卜师暂时失联：${e instanceof Error ? e.message : "未知错误"}` };
      return;
    }
    if (decision.reasoning) {
      yield { type: "reasoning", reasoning: decision.reasoning };
    }
    session.messages.push(decision.message);

    const toolCalls = decision.message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // 模型直接产出文本（不该发生，但兜底）：作为解读输出
      const text = decision.message.content;
      if (text) {
        for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
          yield { type: "delta", delta: chunk };
        }
      }
      yield { type: "done" };
      session.finished = true;
      return;
    }

    // ---- 逐个执行工具 ----
    for (const tc of toolCalls) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch { /* 空参数 */ }

      const t0 = Date.now();

      if (name === "write_reading") {
        // ---- 流式撰写：事件流的核心 ----
        const focus = (args.focus as string) || "综合";
        yield { type: "phase", phase: "interpret", label: `占卜师正在撰写命运之卷（侧重：${focus}）…` };

        // 组装撰写上下文：已有对话 + 牌面知识 + RAG 上下文
        const cardKnowledge = session.drawnCards.length
          ? buildCardKnowledge(session.drawnCards)
          : "（尚未抽牌）";
        const ragContext = session.ragHits.length
          ? buildPromptContext(session.ragHits)
          : "（未检索）";

        const writeMessages: SessionMessage[] = [
          ...session.messages,
          {
            role: "user",
            content: `现在请撰写最终解读报告。可引用的典籍上下文：\n${ragContext}\n\n牌面知识：\n${cardKnowledge}\n\n侧重：${focus}。直接输出解读正文，不要调用任何工具。`,
          },
        ];

        try {
          for await (const chunk of streamLLM(config, writeMessages, (r) => {
            // reasoning 通过事件透出（节流：整段发）
          })) {
            yield { type: "delta", delta: chunk };
          }
          // 流式 reasoning 单独补发（streamLLM 回调中不逐字发，改为收集）
        } catch (e) {
          yield { type: "error", error: `撰写中断：${e instanceof Error ? e.message : "未知"}` };
          return;
        }

        session.messages.push({
          role: "assistant",
          content: "（已完成解读报告撰写）",
        });
        session.finished = true;
        yield { type: "done" };
        return;
      }

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
        const { summary, hits } = execRagSearch(q, topK, session);
        resultSummary = summary;
        evExtra = { ragHits: hits };
        yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${q}」` };
      } else if (name === "ask_user") {
        const askQ = String(args.question || "请补充你的困惑");
        const options = Array.isArray(args.options) ? (args.options as string[]).map(String) : undefined;
        yield {
          type: "phase",
          phase: "wait_user",
          label: "占卜师需要你的回应…",
        };
        yield {
          type: "ask_user",
          ask: {
            question: askQ,
            options,
            allowFree: true,
            prompt: askQ,
          },
        };

        // ---- HITL：挂起等待 /api/answer ----
        const userAnswer: string = await new Promise<string>((resolve) => {
          session.pendingAsk = { resolve, question: askQ, options };
        });

        resultSummary = `用户回答：${userAnswer.slice(0, 60)}`;
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ answer: userAnswer }),
        });
        yield { type: "phase", phase: "analyze", label: `已收到你的回应，占卜继续…` };
        // 继续下一个工具/决策
        continue; // 注意：ask_user 的 tool 消息已 push，跳过下方通用 push
      } else {
        resultSummary = `未知工具：${name}`;
      }

      // ---- 通用工具结果回填 ----
      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({ result: resultSummary, ...(evExtra.ragHits ? { hits: evExtra.ragHits.length } : {}) }),
      });

      yield {
        type: "tool",
        tool: {
          name,
          args,
          resultSummary,
          durationMs: Date.now() - t0,
        },
        ...evExtra,
      };
    }
  }

  yield { type: "error", error: "占卜师陷入沉思无法自拔…（达到最大轮次）" };
}

/* ------------------------------------------------------------------ */
/* 无 Key 降级：剧本式模拟 Agent 循环                                   */
/* ------------------------------------------------------------------ */

async function* runLocalFallback(session: AgentSession, question: string): AsyncGenerator<AgentEvent> {
  // 模拟：analyze → ask_user（澄清） → draw → rag → interpret
  yield { type: "phase", phase: "analyze", label: "（本地引擎）分析问题领域…" };
  await sleep(500);

  const domainHint = /爱|恋|婚|感情|复合|桃花|他|她|喜欢/.test(question) ? "情感"
    : /工作|事业|职场|跳槽|升职|求职/.test(question) ? "事业"
    : /钱|财|投资|理财/.test(question) ? "财富" : "综合";

  // 模拟澄清问题
  yield { type: "phase", phase: "wait_user", label: "占卜师需要你的回应…" };
  const answer = await new Promise<string>((resolve) => {
    session.pendingAsk = { resolve, question: `关于「${question}」，你更想了解哪方面？`, options: ["原因与现状", "未来走向", "行动建议"] };
  });
  const askEvt: AgentEvent = {
    type: "ask_user",
    ask: { question: `关于「${question}」，你更想了解哪方面？`, options: ["原因与现状", "未来走向", "行动建议"], allowFree: true, prompt: `关于「${question}」，你更想了解哪方面？` },
  };
  yield askEvt;

  // 模拟抽牌
  const spread = domainHint === "综合" ? "single" : "three";
  const { summary, cards } = execDrawCards(spread, session);
  const cardNames = (cards ?? []).map((c) => c.nameZh).join(" ");
  yield { type: "phase", phase: "draw", label: `命运之牌已抽出（${spread === "single" ? "单张聚焦" : "三张时间流"}）` };
  yield { type: "cards", cards };
  yield { type: "tool", tool: { name: "draw_cards", args: { spread }, resultSummary: summary, durationMs: 120 } };

  // 模拟 RAG
  await sleep(400);
  const { summary: ragSummary, hits } = execRagSearch(question + " " + cardNames, 5, session);
  yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${question.slice(0, 12)}…」` };
  yield { type: "rag_hits", ragHits: hits };
  yield { type: "tool", tool: { name: "rag_search", args: { query: question.slice(0, 20) }, resultSummary: ragSummary, durationMs: 80 } };

  // 模拟撰写
  yield { type: "phase", phase: "interpret", label: "占卜师正在撰写命运之卷…" };
  const text = localInterpret(question, session.drawnCards, domainHint, answer);
  for (const chunk of text.match(/[\s\S]{1,6}/g) ?? []) {
    yield { type: "delta", delta: chunk };
    await sleep(16);
  }
  session.finished = true;
  yield { type: "done" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* 本地解读模板（降级用）                                               */
/* ------------------------------------------------------------------ */

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
  lines.push(`  三牌关键词汇聚：${kw.join("、")}。`);
  lines.push(`  你所求的「${userAnswer}」，牌面提示：既需倾听内心，也需勇敢行动。`);
  lines.push("");
  lines.push("愿星辰指引你的路。✨");
  return lines.join("\n");
}

export { getCardById, TAROT_CARDS };
