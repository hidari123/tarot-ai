import {
  createSession,
  getSession,
  runAgent,
  tryAcquireSession,
  releaseSession,
  type AgentEvent,
} from "@/lib/tarot-agent";
import { validateAgentEvent } from "@/lib/agent/schema";
import { recordEvent, eventsSince, persistEvent } from "@/lib/agent/event-log";
import { resolveMode } from "@/lib/agent/divination-mode";
import { resolveKind } from "@/lib/agent/session-kind";
import { failSession } from "@/lib/db";
import {
  clampText, LIMITS, deriveUserKey, withSecurityHeaders, badRequest, checkBodySize,
} from "@/lib/api-auth";

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
 *
 * ⚠️ P1-④（公网标准）：
 *   · 输入长度上限（question/followup）—— 防单请求放大 token 成本
 *   · userKey **服务端派生** —— 客户端不能指定别人的画像主键
 *   · 响应统一加安全头
 */
export async function POST(req: Request) {
  // ⚠️ 请求体大小上限（防成本放大：10MB 的 question 会进每一轮 prompt）
  if (!checkBodySize(req)) {
    return badRequest(`请求体过大（上限 ${Math.round(LIMITS.bodyBytes / 1024)}KB）`);
  }

  let body: {
    question?: string;
    followup?: string;
    sessionId?: string;
    persona?: string;
    userKey?: string;
    /** 断点续传：只要后端补发事件，不推进流程 */
    resume?: boolean;
    /**
     * 占卜模式（2026-11-04 双模式）："quick" | "deep"
     * ⚠️ 客户端可控 → 用 resolveMode 宽容解析（非法值退回默认，不报错）
     */
    mode?: string;
    /**
     * 会话种类（2026-11-04 D 方向）："divination" | "oracle"
     * ⚠️ 神谕 = 免抽牌的对话式塔罗向导
     */
    kind?: string;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("请求体必须是合法 JSON");
  }

  let session;
  let question = "";
  let followup: string | undefined;
  /** ⚠️ P1-⑦：本请求是否已原子占用会话（需要在 finally 里释放） */
  let acquired = false;

  if (body.sessionId) {
    session = getSession(body.sessionId);
    if (!session) {
      return withSecurityHeaders(
        Response.json({ error: "会话已过期，请重新开始占卜" }, { status: 410 })
      );
    }
    // ⚠️ 断点续传（P1-③D）：resume 请求只需补发事件，不推进流程。
    //    因此**不能**走下面的 busy 检查（会话正在推进是正常的）。
    if (body.resume === true) {
      question = session.question;
    } else {
      // ⚠️ P1-⑦：并发互斥改为**原子占用**（tryAcquireSession）
      //    原来是"路由层检查 busy" + "supervisor 里设置 busy" 两步，
      //    中间有 await 间隙 → 两个并发追问能同时通过检查
      //    → assistant→tool 配对错位 → 400 → **该会话之后所有追问都失败**。
      //    tryAcquireSession 把"检查 + 占用"放在同一个同步段里，天然原子。
      if (!tryAcquireSession(body.sessionId)) {
        return withSecurityHeaders(
          Response.json({ error: "这场占卜正在进行中，请先回应占卜师或稍候" }, { status: 409 })
        );
      }
      acquired = true;
      followup = clampText(body.followup, LIMITS.followup).trim();
      if (!followup) {
        // ⚠️ P1-⑦：已经占用了会话，提前返回前**必须释放**
        //    否则这个会话永远卡在 busy → 后续追问全部 409。
        releaseSession(body.sessionId);
        acquired = false;
        return badRequest("请写下你的追问");
      }
      question = session.question;
    }
  } else {
    question = clampText(body.question, LIMITS.question).trim();
    if (!question) {
      return badRequest("请先写下你的问题");
    }
    // ⚠️ P1-④：userKey **服务端派生**（客户端传的只作区分维度）
    //    审计实测：客户端可指定任意 userKey → 读写他人的跨会话画像。
    const userKey = deriveUserKey(req, body.userKey);
    // 2026-11-04：占卜模式（快速/深度）—— resolveMode 宽容解析，
    //   非法值退回默认模式，不报错、不中断占卜。
    const mode = resolveMode(body.mode);
    // 2026-11-04 D 方向：会话种类（占卜 / 神谕）—— 同样宽容解析。
    //   ⚠️ 神谕时 mode 无意义（没有仪式）→ 仍传默认值，由 kind 决定行为。
    const kind = resolveKind(body.kind);
    session = createSession(question, body.persona, userKey, mode, kind);
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
          // ⚠️ P1-④：不把内部异常原文返给客户端
          //    （llm.ts 抛的是 `LLM 调用失败(429): {上游原始响应体}`，
          //      会泄露上游网关细节）
          console.error("[interpret] 引擎异常:", e);
          send({ type: "error", error: "占卜引擎遇到问题，请稍后重试" });
          try { failSession(sid, "engine_exception"); } catch { /* ignore */ }
        }
      } finally {
        closed = true;
        req.signal.removeEventListener("abort", onAbort);
        try { controller.close(); } catch { /* 已关闭 */ }
        // ⚠️ P1-⑦：释放原子占用
        //    （supervisor 的 finally 也会释放，但那条路径不一定被走到 ——
        //      比如 followup 为空的 400、或流还没启动就断线）
        if (acquired) releaseSession(sid);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // ⚠️ P1-④：Connection 是 hop-by-hop 头，HTTP/2 下被禁止
      //    （某些代理会报错）—— Node/Next 自动管理，别手写
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
    },
  });
}
