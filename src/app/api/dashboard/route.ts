import { getDashboardStats } from "@/lib/db";
import { checkDashboardAuth, withSecurityHeaders, unauthorized } from "@/lib/api-auth";

/**
 * 观测面板数据接口
 * GET /api/dashboard → 会话/工具调用/token 统计 + 最近解读列表
 *
 * ⚠️ P1-④：面板**必须鉴权**（公网部署标准）
 *   审计实测：这个接口原本**完全公开**，返回全站用户的
 *   问题原文 + 全部解读 + 错误分布 + 内部统计。
 *   占卜问题往往涉及感情/健康/财务 —— 是最敏感的一类数据。
 *
 * ⚠️ 鉴权方式：共享 token（Authorization: Bearer / X-Access-Token）
 *   · 面板是**运维/演示**工具，不是终端用户功能 → 不需要完整用户体系
 *   · 未配置 DASHBOARD_TOKEN 时 **fail closed**（拒绝访问）
 *     —— 公网部署下"没配置就放开"是危险的默认值
 *   · 开发时用 DASHBOARD_TOKEN=dev 显式放开
 */
export async function GET(req: Request) {
  if (!checkDashboardAuth(req)) {
    return unauthorized("观测面板需要访问令牌（Authorization: Bearer <DASHBOARD_TOKEN>）");
  }
  try {
    const stats = getDashboardStats();
    return withSecurityHeaders(Response.json(stats));
  } catch (e) {
    // ⚠️ 不把内部异常原文返给客户端（可能带表名/列名/SQL 片段）
    console.error("[dashboard] 统计失败:", e);
    return withSecurityHeaders(
      Response.json({ error: "统计失败" }, { status: 500 })
    );
  }
}
