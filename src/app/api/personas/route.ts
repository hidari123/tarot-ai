import { PERSONAS } from "@/lib/tarot-agent";

/**
 * 占卜师人格列表
 * GET /api/personas
 */
export async function GET() {
  return Response.json({
    personas: PERSONAS.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, desc: p.desc })),
  });
}
