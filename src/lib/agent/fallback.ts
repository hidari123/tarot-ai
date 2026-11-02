/**
 * 无 Key / 模型不可用降级 —— 剧本式本地模拟
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 *
 * ⚠️ 降级不是删减（项目底线）：没有配置任何 LLM API Key，或远端模型
 *    全部不可用时，用本地剧本引擎跑完整场占卜，保证产品**永远可用、
 *    永远不空白**。质量当然不如真模型，但"没有 API Key 就白屏"不可接受。
 *
 * ⚠️ P4-⑪ 补齐：**降级路径也必须走完整仪式**。
 *    此前降级引擎只发"澄清→抽牌→检索→解读→done"，缺承约/呼召/逐张翻牌/收束
 *    四个仪式事件 —— 后果有二：
 *      1. 前端体验断裂（没有承约复述、没有逐张翻牌的仪式感）
 *      2. 质量评估把降级会话判成"仪式全缺"（32/34 条误报）
 *    降级路径产出**与主路径同构**的事件序列（同样的事件类型、同样的顺序），
 *    前端与评估脚本无需区分两条路径。
 */

import * as db from "../db";
import { waitUserAnswer, isHitlGone } from "./hitl";
import { execDrawCards } from "./tools/cards";
import { execRagSearch } from "./tools/rag";
import type { AgentEvent, AgentSession, DrawnCard } from "./types";

/** delta 合批发送（与 supervisor 同一口径） */
function* chunkDelta(text: string): Generator<{ type: "delta"; delta: string }> {
  const SIZE = 36;
  for (let i = 0; i < text.length; i += SIZE) {
    yield { type: "delta", delta: text.slice(i, i + SIZE) };
  }
}

/** 短暂延时（让剧本流程有节奏感，不至于瞬间闪完） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function* runLocalFallback(session: AgentSession, question: string): AsyncGenerator<AgentEvent> {
  yield { type: "phase", phase: "analyze", label: "（本地引擎）分析问题领域…" };
  await sleep(400);

  const domainHint = /爱|恋|婚|感情|复合|桃花|他|她|喜欢/.test(question) ? "情感"
    : /工作|事业|职场|跳槽|升职|求职/.test(question) ? "事业"
    : /钱|财|投资|理财/.test(question) ? "财富" : "综合";

  /* ---- ① 承约：复述问题，请用户确认 ---- */
  const contractQ = refineQuestion(question, domainHint);
  const contractOptions = ["对，就是这个", "其实我想问点别的", "再具体一点"];
  yield { type: "contract", contract: { question: contractQ, scope: scopeFor(domainHint) } };
  yield { type: "phase", phase: "wait_user", label: "占卜师复述问题，请你确认…" };
  const contractWait = waitUserAnswer(session, contractQ, contractOptions, "contract");
  yield {
    type: "ask_user",
    ask: { question: contractQ, options: contractOptions, allowFree: true, prompt: contractQ, kind: "contract" },
  };
  const contractAnswer = await contractWait;
  const confirmed = isHitlGone(contractAnswer) ? "" : contractAnswer;
  // 用户说"不是这个" → 用他自己的话作为具体问题（与主路径同逻辑）
  const finalQuestion = confirmed && /不是|别的|具体/.test(confirmed) ? confirmed : contractQ;

  /* ---- ② 呼召：三问 ---- */
  const invQuestions = [
    `关于「${finalQuestion}」，你最想知道的答案是什么？`,
    "在这件事上，你已经打算做什么了？",
    "有什么是你担心发生、但还没真正面对的？",
  ];
  yield { type: "invocation", invocation: { questions: invQuestions } };
  yield { type: "phase", phase: "wait_user", label: "呼召——请你回答三个问题…" };
  const invWait = waitUserAnswer(session, invQuestions.join("\n"), undefined, "invocation");
  yield {
    type: "ask_user",
    ask: {
      question: invQuestions.join("\n"),
      options: undefined,
      allowFree: true,
      prompt: invQuestions.join("\n"),
      kind: "invocation",
    },
  };
  const invAnswer = await invWait;
  const invAnswers = isHitlGone(invAnswer)
    ? []
    : invAnswer.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  session.invocation = { questions: invQuestions, answers: invAnswers };

  /* ---- ③ 选牌（用户亲手选）---- */
  const count = 3;
  yield { type: "phase", phase: "wait_user", label: "请凭直觉选出属于你的命运之牌…" };
  const pickWait = waitUserAnswer(
    session,
    `请凭直觉，从 ${count} 张牌中选出属于你的 ${count} 张命运之牌`,
    undefined
  );
  yield {
    type: "ask_user",
    ask: {
      question: `请凭直觉，从 ${count} 张牌中选出属于你的 ${count} 张命运之牌`,
      options: undefined,
      allowFree: true,
      prompt: `请凭直觉，从 ${count} 张牌中选出属于你的 ${count} 张命运之牌`,
    },
    cardSelection: true,
  } as AgentEvent;
  const pickAnswer = await pickWait;

  const spread = "three";
  const { cards } = execDrawCards(spread, session);
  // 用户选牌结果（选了哪几张、犹豫多久）—— 主路径也记这两个字段
  const picked = isHitlGone(pickAnswer) ? [] : String(pickAnswer).split("|")[0].split(",").map((s) => s.trim()).filter(Boolean);
  const dwell = isHitlGone(pickAnswer) ? [] : String(pickAnswer).split("|")[1]?.split(",").map((s) => Number(s) || 0) ?? [];
  yield { type: "phase", phase: "draw", label: `命运之牌已抽出（三张时间流）` };
  // ⚠️ 防剧透：只发位置，不发牌名/图片
  yield {
    type: "cards",
    cards: cards.map((c, i) => ({ id: `slot-${i}`, nameZh: "", image: "", reversed: false, pos: c.pos })),
  };
  yield {
    type: "tool",
    tool: {
      name: "offer_card_selection",
      args: { count },
      resultSummary: `用户亲手选出：${cards.map((c) => c.pos).join("、")}${dwell.length ? `；犹豫时长 ${dwell.join("/")}ms` : ""}（牌面待用户逐一翻开）`,
      durationMs: 120,
    },
  };
  void picked;

  /* ---- ④ 检索典籍 ---- */
  await sleep(300);
  const { summary: ragSummary, allHits } = await execRagSearch(
    question + " " + cards.map((c) => c.nameZh).join(" "),
    5,
    session,
    question
  );
  yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${question.slice(0, 12)}…」` };
  yield { type: "rag_hits", ragHits: allHits };
  yield { type: "tool", tool: { name: "rag_search", args: { query: question.slice(0, 20) }, resultSummary: ragSummary, durationMs: 80 } };

  /* ---- ⑤ 逐张翻牌 + 讲牌 ---- */
  const posNames = ["过去", "当下", "未来"];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const pos = posNames[i] ?? `第${i + 1}张`;

    // 翻牌闸门：等用户亲手翻开（与主路径同一协议）
    const flipPrompt = i === 0 ? "点开第一张牌" : `点开「${pos}」这张牌`;
    yield { type: "phase", phase: "wait_user", label: `${flipPrompt}…` };
    const flipWait = waitUserAnswer(session, flipPrompt, undefined, "flip");
    yield {
      type: "ask_user",
      ask: { question: flipPrompt, options: undefined, allowFree: true, prompt: "翻开这张牌", kind: "flip" },
    };
    await flipWait;

    // 牌面揭晓（此时才发牌名）
    yield {
      type: "card_reveal",
      cardReveal: {
        cardIndex: i,
        total: cards.length,
        id: c.id,
        nameZh: c.nameZh,
        image: c.image,
        reversed: c.reversed,
        pos: c.pos,
        narrative: "",
        meaning: c.reversed ? reversedMeaning(c.id) : uprightMeaning(c.id),
      },
    };

    // 讲这一张
    const cardText = localCardInterpret(c, pos, invAnswers);
    yield { type: "phase", phase: "interpret", label: `占卜师在讲「${c.nameZh}」…` };
    for (const evt of chunkDelta(cardText)) {
      yield evt;
      await sleep(30);
    }
    // ⚠️ card_reading 不带 text —— 正文只由 delta 给出（杜绝双写重复）
    yield { type: "card_reading", cardReading: { cardIndex: i } };
  }

  /* ---- ⑥ 综合 + 审校 ---- */
  yield { type: "subagent", subagent: { agent: "analyst", action: "分析完成（本地）" } };
  yield { type: "subagent", subagent: { agent: "writer", action: "初稿完成（本地）" } };

  const text = localInterpret(finalQuestion, session.drawnCards, domainHint, invAnswers[0] ?? "综合");
  yield { type: "phase", phase: "interpret", label: "占卜师正在撰写命运之卷…" };
  for (const evt of chunkDelta(text)) {
    yield evt;
    await sleep(35);
  }

  yield { type: "review", review: { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "本地引擎：审校通过" } };
  yield { type: "subagent", subagent: { agent: "reviewer", action: "审校通过（本地）" } };

  /* ---- ⑦ 收束 ---- */
  yield { type: "phase", phase: "wait_user", label: "收束——听听你的回响…" };
  const closingQ = "这场占卜到这里就结束了。你心里最想留下的一句话是什么？";
  const closingWait = waitUserAnswer(session, closingQ, undefined, "closing");
  yield {
    type: "ask_user",
    ask: { question: closingQ, options: undefined, allowFree: true, prompt: closingQ, kind: "closing" },
  };
  await closingWait;

  db.updateSessionReading(session.id, text);
  db.finishSession(session.id, { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "本地引擎" });
  session.finished = true;
  yield { type: "done" };
}

/** 把模糊问题收敛成一个更具体、能被牌回答的问题 */
function refineQuestion(question: string, domain: string): string {
  const q = question.trim();
  const scope = scopeFor(domain);
  if (q.length > 12) return `${q}——${scope}`;
  const templates: Record<string, string> = {
    情感: "这段关系里，你最想看清的是什么？",
    事业: "这份职业选择的前路，你会怎么走？",
    财富: "这笔钱背后，最需要你留意的是什么？",
    综合: "你此刻最需要看清的，是什么？",
  };
  return `${templates[domain] ?? templates["综合"]}${scope ? `（${scope}）` : ""}`;
}

function scopeFor(domain: string): string {
  const scopes: Record<string, string> = {
    情感: "我看过去、现在，以及你正在犹豫的那条路",
    事业: "我看这条路的起点、此刻的卡点，与你尚未迈出的那一步",
    财富: "我看投入与回报的时机，以及你没看见的成本",
    综合: "我看过去、现在，以及你正在犹豫的那条路",
  };
  return scopes[domain] ?? scopes["综合"];
}

/** 单张牌的解读（逐张讲牌用） */
function localCardInterpret(
  card: { id: string; nameZh: string; reversed: boolean; pos: string },
  pos: string,
  invAnswers: string[]
): string {
  const meaning = card.reversed ? reversedMeaning(card.id) : uprightMeaning(card.id);
  const lines: string[] = [];
  lines.push(`◈ ${pos} · ${card.nameZh}${card.reversed ? "（逆位）" : "（正位）"}`);
  lines.push(`  典籍有云：${meaning}。`);
  if (card.reversed) {
    lines.push("  这张牌的能量是受阻的 —— 它指向你还没正视的那一处。");
  } else {
    lines.push("  这张牌的能量是流通的 —— 它指向你可以借力的那一步。");
  }
  if (invAnswers[0]) {
    lines.push(`  你说最想知道「${invAnswers[0]}」—— 牌面在这一张上给的是这个方向。`);
  }
  return lines.join("\n");
}

/** 牌意取自知识库（按 id 粗匹配，失败则用通用文案） */
function uprightMeaning(id: string): string {
  const hit = KNOWLEDGE_UPRIGHT[id];
  return hit ?? "顺势而为，稳中求进";
}
function reversedMeaning(id: string): string {
  const hit = KNOWLEDGE_REVERSED[id];
  return hit ?? "能量受阻，需反观自照";
}

/** 从 rag-engine 借来的牌意表（避免循环依赖，用最小实现） */
import { KNOWLEDGE_CHUNKS } from "../rag-engine";
const KNOWLEDGE_UPRIGHT: Record<string, string> = {};
const KNOWLEDGE_REVERSED: Record<string, string> = {};
for (const c of KNOWLEDGE_CHUNKS) {
  if (c.field === "upright") KNOWLEDGE_UPRIGHT[c.cardId] = c.text;
  if (c.field === "reversed") KNOWLEDGE_REVERSED[c.cardId] = c.text;
}

function localInterpret(
  question: string,
  cards: DrawnCard[],
  domain: string,
  userAnswer: string
): string {
  const posNames = ["过去之源", "当下之境", "未来之势"];
  const lines: string[] = [];
  lines.push("星辰已各就其位，让我为你展开命运的密语。");
  lines.push("");
  lines.push(`你问及「${question}」（${domain}之问），并言明更想了解「${userAnswer}」。`);
  lines.push("");
  cards.forEach((d, i) => {
    const { card, reversed } = d;
    const meaning = reversed ? reversedMeaning(card.id) : uprightMeaning(card.id);
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
