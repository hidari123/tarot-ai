/**
 * Next.js instrumentation：服务启动时预热向量索引。
 *
 * 此前 warmupVectorIndex 从未被调用：首个 rag_search 在请求内冷加载
 * ONNX 模型（.bin 缓存只覆盖 chunk 矩阵，查询向量仍需模型），
 * 与 hybridSearch 的 8s 软超时竞速——首查秒级延迟，慢机器静默降级 BM25。
 *
 * ⚠️ 但**不能 await 它**（方向⑥ Docker 实测发现）：
 * instrumentation 的 register() 在首个页面请求前执行，
 * await 会把首屏请求堵住 10+ 秒（向量索引构建 + 模型加载）。
 * 改为"启动即触发、后台完成、不阻塞首屏"：
 *   - 首屏立刻可响应（首查可能走 BM25 或哈希降级）
 *   - 预热完成后向量通道自然就绪，后续查询走完整混合检索
 * 这正是"降级链不删"的价值：预热失败/未完成也不影响可用性。
 */
export async function register() {
  // 只在 nodejs runtime 跑（edge 无文件系统）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 不 await：让预热在后台跑，首屏不等它
  void (async () => {
    try {
      const { warmupVectorIndex } = await import("./lib/vector-engine");
      await warmupVectorIndex();
      console.log("[instrumentation] 向量索引预热完成");
    } catch (e) {
      // 预热失败不阻断启动（检索时惰性重试/降级哈希）
      console.warn(
        "[instrumentation] 向量索引预热失败（将惰性加载或降级哈希）:",
        e instanceof Error ? e.message : e
      );
    }
  })();
}
