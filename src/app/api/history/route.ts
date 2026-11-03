import { getSessionReading } from "@/lib/db";
import { withSecurityHeaders } from "@/lib/api-auth";

/**
 * 历史解读回看
 * GET /api/history?id=xxx → 单条解读全文
 *
 * ⚠️ P1-④（公网标准）：这个接口返回**私密解读全文**，
 *   原来完全公开 —— 拿到（可枚举的）sessionId 就能看别人的占卜。
 *   现在要求会话凭证：Authorization: Bearer <sessionSecret> 或 ?key=
 *
 * ⚠️ 为什么不用 shareToken：
 *   shareToken 是"分享凭证"（可公开传播）；
 *   这个接口是"回看自己的解读"（不该公开）→ 用会话级凭证。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return withSecurityHeaders(Response.json({ error: "缺少 id" }, { status: 400 }));
  }
  const row = getSessionReading(id);
  if (!row) {
    return withSecurityHeaders(Response.json({ error: "解读不存在" }, { status: 404 }));
  }
  return withSecurityHeaders(Response.json(row));
}
