/**
 * Next.js instrumentation：服务启动时预热向量索引。
 *
 * 此前 warmupVectorIndex 从未被调用：首个 rag_search 在请求内冷加载
 * ONNX 模型（.bin 缓存只覆盖 chunk 矩阵，查询向量仍需模型），
 * 与 hybridSearch 的 8s 软超时竞速——首查秒级延迟，慢机器静默降级 BM25。
 */
export async function register() {
  // 只在 nodejs runtime 跑（edge 无文件系统）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { warmupVectorIndex } = await import("./lib/vector-engine");
    await warmupVectorIndex();
    console.log("[instrumentation] 向量索引预热完成");
  } catch (e) {
    // 预热失败不阻断启动（检索时惰性重试/降级哈希）
    console.warn("[instrumentation] 向量索引预热失败（将惰性加载或降级哈希）:", e instanceof Error ? e.message : e);
  }
}
