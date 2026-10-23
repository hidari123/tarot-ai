import {
  createSession,
  getSession,
  resolvePendingAsk,
  runAgent,
  type AgentEvent,
} from "@/lib/tarot-agent";

/**
 * 解读接口：Supervisor 工具调用循环 + 子 Agent 管线 + HITL + SSE
 *
 * POST /api/interpret
 *   首次: { question, persona? }
 *   追问: { sessionId, followup }
 */
export async function POST(req: Request) {
  let body: { question?: string; followup?: string; sessionId?: string; persona?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
  }

  let session;
  let question = "";
  let followup: string | undefined;

  if (body.sessionId) {
    session = getSession(body.sessionId);
    if (!session) {
      return Response.json({ error: "会话已过期，请重新开始占卜" }, { status: 410 });
    }
    followup = (body.followup ?? "").trim();
    if (!followup) {
      return Response.json({ error: "请写下你的追问" }, { status: 400 });
    }
    question = session.question;
  } else {
    question = (body.question ?? "").trim();
    if (!question) {
      return Response.json({ error: "请先写下你的问题" }, { status: 400 });
    }
    session = createSession(question, body.persona);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: AgentEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      };
      try {
        for await (const evt of runAgent(session, question, { followup })) {
          send(evt);
        }
      } catch (e) {
        send({ type: "error", error: e instanceof Error ? e.message : "占卜引擎异常" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
