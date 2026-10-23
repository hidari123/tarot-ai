import { drawCards, TAROT_CARDS, type TarotCard } from "@/lib/tarot-cards";

/**
 * 抽牌 API（保留：快速占卜模式/调试用）
 * GET /api/draw?n=3&ids=Fool,Magician（ids 可选：指定抽某几张）
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const n = Math.min(Math.max(Number(url.searchParams.get("n")) || 3, 1), 10);
  const idsParam = url.searchParams.get("ids");

  let cards: { card: TarotCard; reversed: boolean }[];
  if (idsParam) {
    const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
    cards = ids
      .map((id) => {
        const card = TAROT_CARDS.find((c) => c.id === id);
        return card ? { card, reversed: Math.random() < 0.35 } : null;
      })
      .filter((x): x is { card: TarotCard; reversed: boolean } => x !== null);
  } else {
    cards = drawCards(n);
  }

  return Response.json({
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
  });
}
