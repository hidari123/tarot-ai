import { resolvePendingAsk, getSession, markSessionDirty } from "@/lib/tarot-agent";

/**
 * HITL 应答接口：用户回答占卜师的 ask_user 问题
 * POST /api/answer  body: { sessionId, answer } | { sessionId, answers: string[] }
 *
 * 原理：Agent 循环在 ask_user 处 await 一个 Promise，
 * 本接口 resolve 它，挂起的 SSE 流随即恢复推进。
 *
 * 多答案形式（answers 数组）：用于 A3 三问呼召——一次提交三个回答。
 * 后端会把数组拼成一个带编号的文本块传回给 Agent。
 */
export async function POST(req: Request) {
  let body: { sessionId?: string; answer?: string; answers?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
  }

  const { sessionId, answer, answers } = body;
  if (!sessionId) {
    return Response.json({ error: "缺少 sessionId" }, { status: 400 });
  }

  // 归一化：单条 answer 或多条 answers → 一个文本
  let payload: string;
  if (Array.isArray(answers) && answers.length > 0) {
    const parts = answers.map((a, i) => `${i + 1}. ${String(a ?? "").trim()}`).filter((s) => s.length > 3);
    payload = parts.join("\n");
  } else {
    payload = String(answer ?? "").trim();
  }
  if (!payload) {
    return Response.json({ error: "缺少回答内容" }, { status: 400 });
  }

  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ error: "会话已过期" }, { status: 410 });
  }

  const ok = resolvePendingAsk(sessionId, payload);
  if (!ok) {
    // ⚠️ P1-④：恢复出来的会话**没有 pendingAsk**（Promise 不可序列化）。
    //    此时前端看到的是"当前没有等待回答的问题"—— 但用户不知道原因。
    //    给出明确文案：会话已从快照恢复，但等待回答的状态无法恢复，
    //    请重新开始（而不是让用户以为是自己的操作错了）。
    if (session.restoredFromSnapshot) {
      return Response.json(
        { error: "这场占卜已从快照恢复，但对话的等待状态无法恢复（进程重启所致），请重新开始占卜" },
        { status: 409 }
      );
    }
    return Response.json({ error: "当前没有等待回答的问题" }, { status: 409 });
  }

  // P1-④：用户回答是**关键状态变更** → 立即标脏（下次定时器落库）
  markSessionDirty(sessionId);

  return Response.json({ ok: true });
}
