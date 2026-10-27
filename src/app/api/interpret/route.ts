import {
  createSession,
  getSession,
  runAgent,
  type AgentEvent,
} from "@/lib/tarot-agent";
import { failSession } from "@/lib/db";

/**
 * 解读接口：Supervisor 工具调用循环 + 子 Agent 管线 + HITL + SSE
 *
 * POST /api/interpret
 *   首次: { question, persona? }
 *   追问: { sessionId, followup }
 *
 * SSE 事件（12 类）：session / phase / reasoning / tool / rag_hits / cards /
 *                    ask_user / subagent / review / delta / done / error
 */
export async function POST(req: Request) {
  let body: { question?: string; followup?: string; sessionId?: string; persona?: string; userKey?: string };
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
    // ⚠️ 并发互斥：会话正在推进（生成器运行中 / 挂在 HITL 等待）时，
    // 新 interpret 会把消息插到未配对的 tool_calls 后 → 协议 400 + 历史交叉污染。
    if (session.busy) {
      return Response.json({ error: "这场占卜正在进行中，请先回应占卜师或稍候" }, { status: 409 });
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
    // 方向①：userKey 用于跨会话画像（无则不留痕——匿名访客）
    session = createSession(question, body.persona, body.userKey?.trim() || undefined);
  }

  // 把客户端断开信号注入会话：HITL 等待中的 Promise 可被取消（防生成器/内存泄漏）
  session.abortSignal = req.signal;

  const encoder = new TextEncoder();
  const sid = session.id;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let aborted = false;

      const send = (evt: AgentEvent) => {
        if (closed || aborted) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // ---- 客户端断开检测 ----
      // 浏览器关闭标签页 / 网络中断 → req.signal 触发 abort。
      // 不处理的话会话永远停在 running（实测占比高达 45%）。
      const onAbort = () => {
        aborted = true;
        try { failSession(sid, "client_disconnect"); } catch { /* ignore */ }
        try { controller.close(); } catch { /* 已关闭 */ }
      };
      req.signal.addEventListener("abort", onAbort, { once: true });

      try {
        for await (const evt of runAgent(session, question, { followup })) {
          send(evt);
          if (aborted) break;
        }
        // 生成器结束但客户端已断开 → 标记为断开而非完成
        if (aborted) {
          try { failSession(sid, "client_disconnect"); } catch { /* ignore */ }
        }
      } catch (e) {
        if (!aborted) {
          send({ type: "error", error: e instanceof Error ? e.message : "占卜引擎异常" });
          try { failSession(sid, "engine_exception"); } catch { /* ignore */ }
        }
      } finally {
        closed = true;
        req.signal.removeEventListener("abort", onAbort);
        try { controller.close(); } catch { /* 已关闭 */ }
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
