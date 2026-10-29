/**
 * 抽牌工具 —— 随机抽牌 + 选牌扇面
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 */

import * as db from "../../db";
import { TAROT_CARDS, type TarotCard } from "../../tarot-cards";
import type { AgentSession, DrawnCard } from "../types";

/** 随机抽牌（AI 抽，用户不选） */
export function execDrawCards(spread: string, session: AgentSession) {
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

/** 生成选牌扇面（用户亲手选 3 张） */
export function buildFanCards(count = 7): TarotCard[] {
  const pool = [...TAROT_CARDS];
  const fan: TarotCard[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    fan.push(pool.splice(idx, 1)[0]);
  }
  return fan;
}

/**
 * 应用用户的选牌结果（id 列表 + 每张的犹豫时长）。
 *
 * @param dwellMs 每张牌的犹豫时长（-1 表示用户选了"让星辰替我选"= 随机代抽）
 */
export function applyFanSelection(
  session: AgentSession,
  ids: string[],
  dwellMs: number[]
): { summary: string; cards: Array<{ id: string; nameZh: string; image: string; reversed: boolean; pos: string }> } {
  const drawn: DrawnCard[] = [];
  for (const id of ids) {
    const card = TAROT_CARDS.find((c) => c.id === id);
    if (card) drawn.push({ card, reversed: Math.random() < 0.35 });
  }
  session.drawnCards = drawn;
  session.dwellTimes = dwellMs;
  const posNames = ["过去", "当下", "未来"];
  const cards = drawn.map((d, i) => ({
    id: d.card.id, nameZh: d.card.nameZh, image: d.card.image,
    reversed: d.reversed, pos: drawn.length === 1 ? "核心指引" : posNames[i] ?? `第${i + 1}张`,
  }));
  const summary = drawn.map((d, i) => `${cards[i].pos}=${d.card.nameZh}${d.reversed ? "(逆位)" : ""}`).join("、");
  db.updateSessionCards(session.id, cards);
  return { summary, cards };
}
