import { getSession } from "@/lib/tarot-agent";
import { getSessionReading, getSessionTimings } from "@/lib/db";

/**
 * 会话恢复接口（方向④）：刷新/断线后前端重建对话流（断点续传）
 *
 * GET /api/session/[id]
 * 返回：
 *   - 进行中会话：question / persona / cards / 已完成的牌解读 / 对话流事件重建数据
 *   - 已完成会话：reading 全文 + cards + 状态
 *   - 不存在：404
 */

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // 内存中的活跃会话（进行中 / 挂在 HITL）
  const live = getSession(id);
  if (live) {
    return Response.json({
      status: live.finished ? "done" : "running",
      question: live.question,
      persona: live.persona.id,
      cards: live.drawnCards.map((d, i) => ({
        id: d.card.id, nameZh: d.card.nameZh, image: d.card.image,
        reversed: d.reversed,
        pos: live.drawnCards.length === 1 ? "核心指引" : ["过去", "当下", "未来"][i] ?? `第${i + 1}张`,
      })),
      /** 逐张解读进度（前端重建 card 条目） */
      cardReadings: live.cardReadings.map((r) => ({
        cardId: r.cardId, nameZh: r.nameZh, pos: r.pos,
        reveal: r.reveal, answer: r.answer, reading: r.reading,
      })),
      /** 收束正文（若已生成） */
      reading: live.reading ?? "",
      /** 画像注入提示（前端显示"占卜师还记得你"） */
      hasMemory: !!live.userKey,
      timings: getSessionTimings(id).slice(-20),
    });
  }

  // DB 中的已完成/失败会话
  const persisted = getSessionReading(id);
  if (persisted) {
    return Response.json({
      status: "finished",
      question: persisted.question,
      cards: persisted.cards,
      reading: persisted.reading,
      timings: getSessionTimings(id).slice(-20),
    });
  }

  return Response.json({ error: "会话不存在或已过期" }, { status: 404 });
}
