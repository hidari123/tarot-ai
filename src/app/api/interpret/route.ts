import { getCardById, type TarotCard } from "@/lib/tarot-cards";
import {
  createSession,
  getSession,
  resolvePendingAsk,
  runAgent,
  type AgentEvent,
  type DrawnCard,
} from "@/lib/tarot-agent";

/**
 * 解读接口：Agent tool-calling 循环 + HITL + SSE 流式输出
 *
 * POST /api/interpret
 *   首次: { question }
 *   追问: { sessionId, followup }
 *
 * SSE 事件流（data: {...}\n\n）：
 *   phase     阶段推进（analyze/draw/retrieve/interpret/wait_user/done）
 *   reasoning LLM 思考链片段（glm-5.3 reasoning_content）
 *   tool      工具调用记录（Trace 面板）
 *   rag_hits  RAG 检索命中（知识面板）
 *   cards     抽牌结果
 *   ask_user  向用户提问（HITL 挂起点）
 *   delta     流式解读文本
 *   done      完成
 *   error     错误
 */
export async function POST(req: Request) {
  let body: { question?: string; followup?: string; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
  }

  let session;
  let question = "";
  let followup: string | undefined;

  if (body.sessionId) {
    // ---- 追问模式：复用会话 ----
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
    // ---- 首次占卜 ----
    question = (body.question ?? "").trim();
    if (!question) {
      return Response.json({ error: "请先写下你的问题" }, { status: 400 });
    }
    session = createSession(question);
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
