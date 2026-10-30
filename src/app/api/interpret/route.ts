import {
  createSession,
  getSession,
  runAgent,
  type AgentEvent,
} from "@/lib/tarot-agent";
import { validateAgentEvent } from "@/lib/agent/schema";
import { recordEvent, eventsSince, persistEvent } from "@/lib/agent/event-log";
import { failSession } from "@/lib/db";

/**
 * 解读接口：Supervisor 工具调用循环 + 子 Agent 管线 + HITL + SSE
 *
 * POST /api/interpret
 *   首次: { question, persona? }
 *   追问: { sessionId, followup }
 *
 * SSE 事件（20 类）：session / phase / reasoning / tool / rag_hits / cards /
 *                    ask_user / subagent / review / delta / card_reveal /
 *                    card_reading / card_flip_ready / contract / invocation /
 *                    round / plan / persona_suggest / done / error
 *
 * ⚠️ 协议校验：事件在**下发前**过一遍 zod schema（开发期）。
 *    协议写错立刻在服务端暴露，而不是等前端渲染时 undefined 崩溃。
 *
 * ⚠️ 断点续传（P1-③D）：每个事件带单调递增 `id`（SSE 标准 id 字段），
 *    前端断线重连时带 `Last-Event-ID: <seq>` → 后端补发缺失事件。
 *    "流式 AI 应用的真实难点不是推流，是断流。"
 */
export async function POST(req: Request) {
  let body: {
    question?: string;
    followup?: string;
    sessionId?: string;
    persona?: string;
    userKey?: string;
    /** 断点续传：只要后端补发事件，不推进流程 */
    resume?: boolean;
  };
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
    // ⚠️ 断点续传（P1-③D）：resume 请求只需补发事件，不推进流程。
    //    因此**不能**走下面的 busy 检查（会话正在推进是正常的）。
    if (body.resume === true) {
      question = session.question;
    } else {
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
    }
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

  /**
   * ⚠️ 断点续传（P1-③D）：解析客户端带来的 Last-Event-ID。
   *
   * 两种重连语义要区分：
   *   ① **纯补发**：客户端只是断了流，会话还在推进 —— 补发缺失事件后
   *      继续订阅后续事件（后端不能再跑一遍 agent）。
   *   ② **重跑**：客户端想重新开始一场（新的 sessionId）——
   *      这种情况 Last-Event-ID 不该被当成补发请求。
   *
   * 判定：请求带 `resume: true` 显式声明要补发。
   * （SSE 的 Last-Event-ID 是浏览器自动重连时发的，但我们用的是
   *   fetch + ReadableStream（不是 EventSource），浏览器不会自动带，
   *   所以必须由前端显式传。）
   */
  const lastEventId = Number(req.headers.get("last-event-id") ?? 0) || 0;
  const wantsResume = body.resume === true && lastEventId > 0 && !!body.sessionId;

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let aborted = false;

      /**
       * 发送一个事件（带 SSE id 字段 + 记录到缓冲）。
       *
       * ⚠️ SSE 标准格式：`id: <seq>\ndata: <json>\n\n`
       *    前端 EventSource 断线重连会自动带 Last-Event-ID，
       *    我们自己的 fetch 客户端则显式传。
       */
      const send = (evt: AgentEvent, seq?: number) => {
        if (closed || aborted) return;
        try {
          // ⚠️ 开发期协议校验：字段写错立刻在这里暴露（不抛异常，降级不删）
          const validated = validateAgentEvent(evt);
          const idLine = seq !== undefined ? `id: ${seq}\n` : "";
          controller.enqueue(
            encoder.encode(`${idLine}data: ${JSON.stringify(validated)}\n\n`)
          );
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
        // ---- ① 纯补发：先补齐客户端缺失的事件 ----
        if (wantsResume) {
          const missed = eventsSince(sid, lastEventId);
          for (const m of missed) send(m.evt, m.seq);
          // 补发后**不重跑 agent** —— 会话还在推进（后台生成器），
          // 客户端只是短暂失联。补完就结束这条响应。
          // ⚠️ 若会话已结束（buffer 里的最后一条是 done/error），补发即可。
          if (!missed.length) {
            send({ type: "error", error: "无法恢复该会话的事件流（缓冲区已过期）" });
          }
          return;
        }

        // ---- ② 正常跑一场 ----
        for await (const evt of runAgent(session, question, { followup })) {
          // 记录事件（带 seq）→ 供断点续传补发 + 事件日志落库
          const { seq } = recordEvent(sid, evt);
          persistEvent(sid, seq, evt);
          send(evt, seq);
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
