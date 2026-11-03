import { drawCards, TAROT_CARDS, type TarotCard } from "@/lib/tarot-cards";
import { withSecurityHeaders } from "@/lib/api-auth";

/**
 * 抽牌 API（保留：快速占卜模式/调试用）
 * GET /api/draw?n=3&ids=Fool,Magician（ids 可选：指定抽某几张）
 *
 * ⚠️ P1-④：ids 长度上限
 *   审计实测：ids 无上限 → `ids=Fool,Magician,` × 10000
 *   → 解析 10000 个 id 逐个 `TAROT_CARDS.find`（O(n×78)）→ 轻微 DoS。
 *   现在限制最多 20 个（实际最多 3~5 张）。
 */
const MAX_IDS = 20;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 3, 1), 10);
  const idsParam = url.searchParams.get("ids");

  let cards: { card: TarotCard; reversed: boolean }[];
  if (idsParam) {
    // ⚠️ 长度上限（防 O(n×78) 的解析放大）
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_IDS);
    cards = ids
      .map((id) => {
        const card = TAROT_CARDS.find((c) => c.id === id);
        return card ? { card, reversed: Math.random() < 0.35 } : null;
      })
      .filter((x): x is { card: TarotCard; reversed: boolean } => x !== null);
  } else {
    cards = drawCards(n);
  }

  return withSecurityHeaders(Response.json({
    cards: cards.map(({ card, reversed }) => ({
      id: card.id,
      name: card.name,
      nameZh: card.nameZh,
      nameEn: card.nameEn,
      number: card.number,
      suit: card.suit,
      element: card.element,
      reversed,
      keywords: card.keywords,
      image: card.image,
      // 注意：不返回牌意文本，保持"翻牌才有解读"的仪式感
    })),
  }));
}
