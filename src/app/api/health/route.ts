import { vectorStatus } from "@/lib/vector-engine";
import { hasProviders } from "@/lib/llm-providers";

/**
 * 健康检查（方向⑥：容器 HEALTHCHECK + 部署排障）
 *
 * GET /api/health
 *
 * 设计要点：
 * 1. **永远返回 200**：只要进程活着就是"活的"。
 *    向量通道未就绪 / LLM 不可达都属于**降级状态**，不是进程不健康——
 *    返回 503 会让 Docker/K8s 把可降级运行的容器杀掉，反而降低可用性。
 * 2. **状态分层呈现**：ok（完全就绪）/ degraded（降级但可用）
 *    面试讲点：健康检查与优雅降级是两件事，不能混为一谈。
 */
export async function GET() {
  const vec = vectorStatus();
  const llmReady = hasProviders();

  // 降级判定：向量未就绪（走 BM25）或 LLM 未配置（走本地剧本）
  const degraded = !vec.ready || !llmReady;
  const reasons: string[] = [];
  if (!llmReady) reasons.push("未配置 LLM provider（将使用本地剧本引擎）");
  if (!vec.ready) reasons.push(`向量索引未就绪（当前模式 ${vec.mode}，检索走 BM25/哈希降级）`);

  return Response.json({
    status: degraded ? "degraded" : "ok",
    uptimeSec: Math.round(process.uptime()),
    llm: { configured: llmReady },
    vector: vec,
    ...(reasons.length ? { reasons } : {}),
    ts: new Date().toISOString(),
  });
}
