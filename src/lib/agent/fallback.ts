/**
 * 无 Key 降级 —— 剧本式本地模拟
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 *
 * ⚠️ 降级不是删减（项目底线）：没有配置任何 LLM API Key 时，
 *    用本地剧本引擎跑完整场占卜（澄清 → 抽牌 → 念牌 → 解读 → 收束），
 *    保证产品**永远可用、永远不空白**。
 *    质量当然不如真模型，但"没有 API Key 就白屏"是不可接受的。
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
  const askQ = `关于「${question}」，你更想了解哪方面？`;
  const answer = await waitUserAnswer(session, askQ, ["原因与现状", "未来走向", "行动建议"]);
  const userPick = isHitlGone(answer) ? "综合" : answer;

  // 模拟抽牌
  const spread = domainHint === "综合" ? "single" : "three";
  const { summary, cards } = execDrawCards(spread, session);
  yield { type: "phase", phase: "draw", label: `命运之牌已抽出（${spread === "single" ? "单张聚焦" : "三张时间流"}）` };
  // ⚠️ 防剧透：同上文 —— 本地降级引擎也只发位置，不发牌名/图片
  yield {
    type: "cards",
    cards: cards.map((c, i) => ({ id: `slot-${i}`, nameZh: "", image: "", reversed: false, pos: c.pos })),
  };
  yield { type: "tool", tool: { name: "draw_cards", args: { spread }, resultSummary: summary, durationMs: 120 } };

  // 模拟 RAG
  await sleep(400);
  const { summary: ragSummary, allHits } = await execRagSearch(question + " " + cards.map((c) => c.nameZh).join(" "), 5, session, question);
  yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${question.slice(0, 12)}…」` };
  yield { type: "rag_hits", ragHits: allHits };
  yield { type: "tool", tool: { name: "rag_search", args: { query: question.slice(0, 20) }, resultSummary: ragSummary, durationMs: 80 } };

  // 模拟子 Agent
  yield { type: "subagent", subagent: { agent: "analyst", action: "分析完成（本地）" } };
  yield { type: "subagent", subagent: { agent: "writer", action: "初稿完成（本地）" } };

  const text = localInterpret(question, session.drawnCards, domainHint, userPick);
  yield { type: "phase", phase: "interpret", label: "占卜师正在撰写命运之卷…" };
  for (const evt of chunkDelta(text)) {
    yield evt;
    await sleep(40);
  }

  yield { type: "review", review: { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "本地引擎：审校通过" } };
  yield { type: "subagent", subagent: { agent: "reviewer", action: "审校通过（本地）" } };

  db.updateSessionReading(session.id, text);
  db.finishSession(session.id, { pass: true, scores: { grounding: 8, empathy: 8, tone: 8 }, comment: "本地引擎" });
  session.finished = true;
  yield { type: "done" };
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
