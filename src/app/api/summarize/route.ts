import { callLLM } from "@/lib/agent/llm";
import { getSessionReading } from "@/lib/db";
import { clampText, LIMITS, checkBodySize, withSecurityHeaders, badRequest } from "@/lib/api-auth";

/**
 * 分享卡文案总结接口
 * POST /api/summarize  body: { sessionId?, reading? }
 *
 * 把整篇逐张解读浓缩成 80~150 字的分享文案，供 Canvas 分享卡展示。
 * 优先用 body.reading（前端实时全文，占卜中途也能用），
 * 缺失时回落 DB 落库版本。
 *
 * ⚠️ P1-④ / P3-⑩：改走**统一的 LLM 调用层**（callLLM）
 *   审计实测：原实现是**裸调 fetch**，完全绕过了
 *     ① 限速窗口 → 用户点"生成摘要"就在上游配额之外多打一发，
 *        **可能把正在跑的占卜撞出 429**
 *     ② failover → 主用挂了直接 502（而不是切备用）
 *     ③ 熔断 → 已知坏掉的 provider 仍会被调用
 *     ④ usage 记账 → dashboard 成本统计**漏掉这部分开销**
 *   走 callLLM 后四件事全部自动获得。
 */
export async function POST(req: Request) {
  // ⚠️ 请求体大小上限（reading 是整篇解读，可能很长）
  if (!checkBodySize(req)) {
    return badRequest(`请求体过大（上限 ${Math.round(LIMITS.bodyBytes / 1024)}KB）`);
  }

  let body: { sessionId?: string; reading?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("请求体必须是合法 JSON");
  }

  // ⚠️ 输入长度上限（整篇解读进 prompt，不能无限长）
  let reading = clampText(body.reading, 20_000).trim();
  if ((!reading || reading.length < 60) && body.sessionId) {
    try {
      const row = getSessionReading(body.sessionId);
      if (row?.reading) reading = clampText(row.reading, 20_000).trim();
    } catch { /* ignore */ }
  }
  if (!reading || reading.length < 60) {
    return withSecurityHeaders(
      Response.json({ error: "解读内容不足，无法总结" }, { status: 404 })
    );
  }

  const prompt = `你是塔罗占卜解读的文案提炼师。把下面的占卜解读浓缩成一段适合分享卡展示的精华文案。

要求：
1. 80~150 字，一段连贯的话，不分段
2. 保留最有力量的一句结论 + 一条核心行动建议
3. 去掉所有【牌面·…】等段标和 [n] 引文编号，写成流畅自然的文字
4. 保留占卜师的语气温度
5. 直接输出文案本身，不要任何前言或解释

解读原文：
${reading}`;

  try {
    // ⚠️ 走统一调用层：自动获得限速 / failover / 熔断 / usage 记账
    const result = await callLLM(
      null,
      [{ role: "user", content: prompt }],
      undefined,
      body.sessionId,
      "supervisor"
    );

    let text = String(result.message?.content ?? "").trim();
    // 剥离可能的 think 标签与 markdown 代码块包裹
    text = text
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^```\w*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (!text || text.length < 20) {
      return withSecurityHeaders(
        Response.json({ error: "总结结果为空" }, { status: 502 })
      );
    }
    return withSecurityHeaders(Response.json({ summary: text, length: text.length }));
  } catch (e) {
    // ⚠️ 不把内部异常原文返给客户端（可能含上游网关细节）
    console.error("[summarize] 总结失败:", e);
    return withSecurityHeaders(
      Response.json({ error: "总结失败，请稍后重试" }, { status: 502 })
    );
  }
}
