import { getSessionEvents, getEventTypeCounts } from "@/lib/db";
import { checkDashboardAuth, withSecurityHeaders, unauthorized } from "@/lib/api-auth";

/**
 * 事件 trace 接口（P1-⑨ · P1-④ 加固）
 *
 * GET /api/dashboard/events?sessionId=xxx  → 某会话的事件时间线
 * GET /api/dashboard/events                → 全局事件类型分布
 *
 * ⚠️ 为什么值得单独一个接口（而不是塞进 /api/dashboard）：
 *   dashboard 的聚合是"全库统计"（缓存 60s），而事件时间线是
 *   **单会话的细粒度数据**（每场 20~60 条）——
 *   两者刷新频率、数据量、访问模式都不同，混在一起会让 dashboard 变重。
 *
 * ⚠️ P1-④：同样需要鉴权 —— 事件流里包含用户的原话与占卜师回应。
 */
export async function GET(req: Request) {
  if (!checkDashboardAuth(req)) {
    return unauthorized("观测面板需要访问令牌");
  }
  try {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get("sessionId");

    if (sessionId) {
      const events = getSessionEvents(sessionId);
      return withSecurityHeaders(Response.json({ sessionId, events }));
    }
    return withSecurityHeaders(Response.json({ counts: getEventTypeCounts() }));
  } catch (e) {
    // ⚠️ 不把内部异常原文返给客户端
    console.error("[dashboard/events] 查询失败:", e);
    return withSecurityHeaders(
      Response.json({ error: "事件查询失败" }, { status: 500 })
    );
  }
}
