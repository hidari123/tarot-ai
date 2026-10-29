/**
 * Agent 辅助函数 —— 情绪提取 / 分支兜底 / 上下文压缩 / 牌槽管理 / 计划生成
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 */

import { PERSONAS } from "../personas";
import type { RagHit } from "../rag-engine";
import type { AgentEvent, AgentSession } from "./types";
import { buildSupervisorPrompt } from "../prompts";
import { buildMemoryContext } from "../memory";
import { callLLM } from "./llm";
import type { LLMProvider } from "../llm-providers";

/* ------------------------------------------------------------------ */
/* 情绪提取                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从用户应答中提取情绪关键词（规则式，轻量零成本）。
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

export function extractEmotionTags(text: string): string[] {
  const tags: string[] = [];
  for (const { tag, words } of EMOTION_LEXICON) {
    if (words.some((w) => text.includes(w))) tags.push(tag);
  }
  return tags.slice(0, 3); // 最多 3 个，避免堆砌
}

/**
 * 情绪驱动的人格切换建议（收束时计算，只建议不强制）。
 *
 * 设计动机：人格是用户入场时凭第一印象选的，但整场占卜中情绪会展开
 * ——开场选了"直断导师"的用户，在三问呼召里暴露出高焦虑（紧张/迷茫），
 * 犀利直断反而加剧不安；反之情绪平稳、目标明确的用户，疗愈系的
 * 温柔绕圈会显得隔靴搔痒。收束点情绪轨迹已完整，是最自然的建议时机。
 */
export function suggestPersonaByEmotion(session: AgentSession): AgentEvent["personaSuggest"] | null {
  const tags = session.emotionTags;
  if (tags.length === 0) return null;
  const anxious = tags.some((t) => ["紧张不安", "迷茫", "失落受挫"].includes(t));
  const driven = tags.some((t) => ["期待希望", "渴望改变", "兴奋跃跃"].includes(t));

  if (anxious && session.persona.id === "blade") {
    const healer = PERSONAS.find((p) => p.id === "healer");
    if (!healer) return null;
    return {
      personaId: healer.id,
      name: healer.name,
      emoji: healer.emoji,
      reason: `这场你的情绪里写着「${tags.join("、")}」——下次不妨让疗愈系的声音陪你走完，先接住情绪，再谈牌面。`,
    };
  }
  if (driven && !anxious && session.persona.id === "healer") {
    const blade = PERSONAS.find((p) => p.id === "blade");
    if (!blade) return null;
    return {
      personaId: blade.id,
      name: blade.name,
      emoji: blade.emoji,
      reason: `你的状态里是「${tags.join("、")}」——目标明确时，或许想听一位不绕弯子的直断导师，一针见血。`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 岔路分支兜底                                                        */
/* ------------------------------------------------------------------ */

/**
 * 从叙述性 prompt 里抠出候选分支（模型漏传 branches 时的兜底）。
 *
 * 识别常见编号格式：
 *   "1. xxx" / "①xxx" / "A. xxx" / "一、xxx"
 * 以及被引号包裹的并列项："…，或「这个」「那个」…"
 * 抠不出则返回空数组，由调用方用通用选项兜底（绝不返回空导致 UI 死锁）。
 */
export function extractBranchesFromPrompt(prompt: string): string[] {
  const branches: string[] = [];

  // ① 编号项
  //    两步走：先单独匹配"编号标记"（不含前置条件，避免吃掉分隔符），
  //    再按标记位置切分文本，逐段清洗。
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

/* ------------------------------------------------------------------ */
/* 牌槽管理                                                            */
/* ------------------------------------------------------------------ */

/**
 * 汇总逐张解读为最终正文（落库用）。
 * 格式与前端 CitedReading 的段落解析一致：【牌面·位置·牌名】 + 正文段
 */
export function buildFinalReading(session: AgentSession): string {
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
export function ensureCardSlot(session: AgentSession, idx: number): AgentSession["cardReadings"][number] {
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

/* ------------------------------------------------------------------ */
/* 上下文压缩                                                          */
/* ------------------------------------------------------------------ */

/**
 * 压缩 RAG 检索结果（注入 prompt 时用）。
 *
 * ⚠️ 关键：**保留全局编号** —— 正文里的 [n] 引用必须与知识面板
 *    显示的编号一致（引文闭环）。压缩时不能重编号。
 */
export function compressRagResult(
  allHits: RagHit[],
  currentChunkIds: Set<string>
): string {
  // 本次命中的条目（保持全局编号），最多 5 条
  const current = allHits
    .map((h, i) => ({ h, n: i + 1 }))
    .filter(({ h }) => currentChunkIds.has(h.chunkId))
    .slice(0, 5);
  if (current.length === 0) return JSON.stringify({ result: "未检索到相关内容" });
  const top = current.map(({ h, n }) => {
    const fieldLabel =
      h.field === "description" ? "叙事" : h.field === "upright" ? "正位" : h.field === "reversed" ? "逆位" : "关键词";
    const brief = h.snippet.length > 40 ? h.snippet.slice(0, 40) + "…" : h.snippet;
    return `[${n}] ${h.cardNameZh}·${fieldLabel}: ${brief}`;
  });
  return JSON.stringify({ hits: top, total: allHits.length, note: "编号为累计命中序号，正文引用 [n] 时与此一致" });
}

/**
 * 压缩历史消息（保持协议完整性 + 控制 token）。
 *
 * ⚠️ 为什么不能直接"删掉旧消息"：
 *   OpenAI 兼容协议要求 assistant(tool_calls) 必须紧跟对应的 tool 消息。
 *   删消息会切断配对 → 下一次请求 400
 *   "tool call result does not follow tool call"
 *
 * 所以策略是**原地压缩**而不是删除：
 *   - 早期 tool 结果 → 换成「（早期结果已压缩）」标记（保留配对）
 *   - 早期 assistant 过渡语 → 一行化（首尾各 ~20 字）
 *   - 抽牌类工具结果**永不压缩**（牌面是后续解读的依据）
 */
export function trimHistory(
  messages: AgentSession["messages"],
  keepFullRounds = 4
): AgentSession["messages"] {
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
  }).map((m) => {
    // 早期 assistant 过渡语一行化：content 的信息量在 tool_calls 骨架之外很低，
    // 但每轮都全文重发（token 线性膨胀）。保留首尾各 ~20 字示意语气。
    if (m.role !== "assistant" || !m.content || m.content.length <= 60) return m;
    const brief = `${m.content.slice(0, 20)}…${m.content.slice(-20)}`;
    return { ...m, content: brief };
  });
}

/* ------------------------------------------------------------------ */
/* 计划与提示词                                                        */
/* ------------------------------------------------------------------ */

export function buildSystemPrompt(session: AgentSession): string {
  // 方向①：跨会话画像注入（占卜师"认识你"——承约阶段自然关联上次困惑）
  const memory = session.userKey ? buildMemoryContext(session.userKey) : "";
  return buildSupervisorPrompt(session.persona) + (memory ? `\n\n${memory}` : "");
}
export async function buildPlanSteps(
  config: LLMProvider | null,
  session: AgentSession
): Promise<string[] | null> {
  try {
    const planRes = await Promise.race([
      callLLM(
        config,
        [
          {
            role: "system",
            content:
              "你是占卜流程规划器。根据用户问题，用 5-8 条短句列出本次塔罗占卜的完整仪轨步骤（每条 ≤15 字，形如「① 确认问题与范围」）。只输出步骤清单，不要任何解释。",
          },
          {
            role: "user",
            content: `用户问题：${session.contractQuestion ?? session.question}\n用户情绪：${session.emotionTags.join("、") || "未知"}`,
          },
        ],
        undefined,
        session.id,
        "supervisor"
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    if (!planRes) return null;
    return (planRes.message.content ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 1 && !/^[-—=*_#>]/.test(l))
      .slice(0, 8);
  } catch {
    return null; // 计划失败降级 ReAct，不阻断主流程
  }
}

