import { resolvePendingAsk, getSession } from "@/lib/tarot-agent";

/**
 * HITL 应答接口：用户回答占卜师的 ask_user 问题
 * POST /api/answer  body: { sessionId, answer }
 *
 * 原理：Agent 循环在 ask_user 处 await 一个 Promise，
 * 本接口 resolve 它，挂起的 SSE 流随即恢复推进。
 */
export async function POST(req: Request) {
  let body: { sessionId?: string; answer?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
  }

  const { sessionId, answer } = body;
  if (!sessionId || !answer?.trim()) {
    return Response.json({ error: "缺少 sessionId 或 answer" }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ error: "会话已过期" }, { status: 410 });
  }

  const ok = resolvePendingAsk(sessionId, answer.trim());
  if (!ok) {
    return Response.json({ error: "当前没有等待回答的问题" }, { status: 409 });
  }

  return Response.json({ ok: true });
}
