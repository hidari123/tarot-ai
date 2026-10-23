import { getDashboardStats } from "@/lib/db";

/**
 * 观测面板数据接口
 * GET /api/dashboard → 会话/工具调用/token 统计 + 最近解读列表
 */
export async function GET() {
  try {
    const stats = getDashboardStats();
    return Response.json(stats);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "统计失败" }, { status: 500 });
  }
}
