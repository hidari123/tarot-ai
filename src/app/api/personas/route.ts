import { PERSONAS } from "@/lib/personas";
import { withSecurityHeaders } from "@/lib/api-auth";

/**
 * 占卜师人格列表
 * GET /api/personas
 *
 * ⚠️ P1-④：公开接口（返回的是静态产品信息，无隐私），
 *    但统一加安全头（防止被嵌入/嗅探）。
 */
export async function GET() {
  return withSecurityHeaders(Response.json({
    personas: PERSONAS.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, desc: p.desc })),
  }));
}
