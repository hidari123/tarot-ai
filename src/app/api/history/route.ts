import { getSessionReading } from "@/lib/db";

/**
 * 历史解读回看
 * GET /api/history?id=xxx → 单条解读全文
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return Response.json({ error: "缺少 id" }, { status: 400 });
  }
  const row = getSessionReading(id);
  if (!row) {
    return Response.json({ error: "解读不存在" }, { status: 404 });
  }
  return Response.json(row);
}
