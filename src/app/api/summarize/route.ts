import { buildProviders } from "@/lib/llm-providers";
import { getSessionReading } from "@/lib/db";

/**
 * 分享卡文案总结接口
 * POST /api/summarize  body: { sessionId?, reading? }
 *
 * 把整篇逐张解读浓缩成 80~150 字的分享文案，供 Canvas 分享卡展示。
 * 优先用 body.reading（前端实时全文，占卜中途也能用），
 * 缺失时回落 DB 落库版本。
 */
export async function POST(req: Request) {
  let body: { sessionId?: string; reading?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体必须是合法 JSON" }, { status: 400 });
  }

  let reading = (body.reading ?? "").trim();
  if ((!reading || reading.length < 60) && body.sessionId) {
    try {
      const row = getSessionReading(body.sessionId);
      if (row?.reading) reading = row.reading;
    } catch { /* ignore */ }
  }
  if (!reading || reading.length < 60) {
    return Response.json({ error: "解读内容不足，无法总结" }, { status: 404 });
  }

  const providers = buildProviders();
  if (providers.length === 0) {
    return Response.json({ error: "无可用模型" }, { status: 503 });
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

  const p = providers[0];
  try {
    const res = await fetch(`${p.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      return Response.json({ error: `总结失败(${res.status})` }, { status: 502 });
    }
    const json = await res.json();
    let text = String(json.choices?.[0]?.message?.content ?? "").trim();
    // 剥离可能的 think 标签与 markdown 代码块包裹
    text = text
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^```\w*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (!text || text.length < 20) {
      return Response.json({ error: "总结结果为空" }, { status: 502 });
    }
    return Response.json({ summary: text, length: text.length });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "总结失败" }, { status: 502 });
  }
}
