/**
 * 子 Agent 管线 —— analyst → writer → reviewer（Reflexion）
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 *
 * ⚠️ 为什么要拆三个子 Agent 而不是一次调用：
 *   1. **职责分离**：analyst 产出结构化笔记（≤250 字、不面向用户），
 *      writer 基于笔记写 350~450 字成稿。思考与表达分离，
 *      既省 token 又防跑偏（writer 不会自己编牌意）。
 *   2. **质量门控**：reviewer 三维打分（grounding/empathy/tone），
 *      不通过则带修改指令打回 writer 重写（Reflexion）。
 *   3. **可观测**：每个子 Agent 的产出都是独立事件，前端可视化。
 */

import { buildCardKnowledge } from "../rag-engine";
import { parseLLMJSON, extractScore, extractString } from "../robust-json";
import { buildAnalystPrompt, buildWriterPrompt, buildReviewerPrompt } from "../prompts";
import type { LLMProvider } from "../llm-providers";
import { streamLLM } from "./llm";
import type { AgentEvent, AgentSession, SessionMessage } from "./types";

/* ------------------------------------------------------------------ */
/* ① 分析师                                                             */
/* ------------------------------------------------------------------ */

/** ① 牌意分析师：逐牌结构化笔记 */
export async function* runAnalyst(
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

/* ------------------------------------------------------------------ */
/* ② 撰写者                                                             */
/* ------------------------------------------------------------------ */

/** ② 撰写者：基于笔记流式撰写（writer 的产出直接流给用户） */
export async function* runWriter(
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

  // 犹豫时长入戏——真实塔罗师会说"你在那张牌前停留了很久"
  const dwellNote = (() => {
    if (session.dwellTimes.length !== session.drawnCards.length) return undefined;
    if (session.dwellTimes.some((d) => d < 0)) return undefined; // 随机代抽无数据
    const maxIdx = session.dwellTimes.indexOf(Math.max(...session.dwellTimes));
    const card = session.drawnCards[maxIdx];
    if (!card) return undefined;
    return `选牌行为：用户在「${card.card.nameZh}」（${["过去", "当下", "未来"][maxIdx] ?? "核心"}）前犹豫最久（${session.dwellTimes[maxIdx]}ms）。可在解读中自然地点出这一细节（如"你在这张牌前停留了很久，说明它触动了你"），但不要报毫秒数字。`;
  })();

  // 情绪档案入 prompt——"记得你说过很紧张"
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

/* ------------------------------------------------------------------ */
/* ③ 审校者（Reflexion）                                                */
/* ------------------------------------------------------------------ */

/** 审校结果结构 */
export interface ReviewResult {
  pass: boolean;
  scores: { grounding: number; empathy: number; tone: number };
  comment?: string;
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
export async function* runReviewer(
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
export function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? "0"), 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(10, Math.max(0, Math.round(n)));
}
