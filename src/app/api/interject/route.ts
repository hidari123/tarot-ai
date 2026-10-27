import { appendInterjection, getSession } from "@/lib/tarot-agent";

/**
 * 插话接口（方案 C）—— 用户在解读过程中主动补充/修正信息
 * POST /api/interject  body: { sessionId, text }
 *
 * 与 /api/answer 的区别：
 *   - /api/answer   回答占卜师**当前正在等**的问题（唤醒挂起的 SSE 流）
 *   - /api/interject 用户主动插话，**不唤醒**任何等待，
 *     只把内容追加进会话历史，接下来翻的牌就能用到这条信息。
 *
 * 真实感来源：真实占卜师讲第二张牌时，用户会插一句"其实我不是不甘心"，
 * 占卜师会当场调整语气与解读方向。
 */
export async function POST(req: Request) {
  let body: { sessionId?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
  }

  const { sessionId, text } = body;
  if (!sessionId || !text?.trim()) {
    return Response.json({ error: "缺少 sessionId 或 text" }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ error: "会话已过期" }, { status: 410 });
  }

  const ok = appendInterjection(sessionId, text.trim());
  if (!ok) {
    return Response.json({ error: "插话失败" }, { status: 409 });
  }

  return Response.json({ ok: true, count: session.interjections.length });
}
