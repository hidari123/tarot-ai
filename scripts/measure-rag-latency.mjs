#!/usr/bin/env node
/**
 * 测量：RAG 检索的实际耗时（为 P1-③ 的并发优化提供真实数据）
 *
 * 关键问题：3 张牌的检索到底能省多少？
 *  - 若单次检索 ~50ms → 并发 3 张只省 ~100ms（不值当）
 *  - 若单次检索 ~500ms → 并发省 ~1s（勉强）
 *  - 若单次检索 ~2s（含 ONNX 推理）→ 并发省 ~4s（值得）
 */
const { hybridSearch } = await import("../src/lib/rag-engine.ts");
const { rewriteQueryLocal } = await import("../src/lib/query-rewrite.ts");
const { TAROT_CARDS } = await import("../src/lib/tarot-cards.ts");

const queries = [
  "愚人 新的开始 冒险",
  "恋人 感情 关系 选择",
  "星星 希望 未来 指引",
];

console.log("\n=== 单次检索耗时（冷启动后）===\n");

// 预热（第一次会加载 ONNX 模型）
const warm = await hybridSearch(queries[0], 5);
console.log(`预热完成: ${warm.length} 条\n`);

const times = [];
for (const q of queries) {
  const rewritten = rewriteQueryLocal(q, TAROT_CARDS.map((c) => c.nameZh));
  const t0 = performance.now();
  await hybridSearch(rewritten, 5);
  const ms = performance.now() - t0;
  times.push(ms);
  console.log(`  ${q.slice(0, 18).padEnd(20)} ${ms.toFixed(1)}ms`);
}

const serial = times.reduce((a, b) => a + b, 0);

// 并发测
const t0 = performance.now();
await Promise.all(
  queries.map((q) => {
    const rewritten = rewriteQueryLocal(q, TAROT_CARDS.map((c) => c.nameZh));
    return hybridSearch(rewritten, 5);
  })
);
const parallel = performance.now() - t0;

console.log(`\n串行 3 次: ${serial.toFixed(1)}ms`);
console.log(`并发 3 次: ${parallel.toFixed(1)}ms`);
console.log(`并发节省: ${(serial - parallel).toFixed(1)}ms (${((1 - parallel / serial) * 100).toFixed(0)}%)`);

// 单线程瓶颈分析：ONNX 推理是 CPU-bound，同步执行无法真并发
console.log(`\n⚠️ 瓶颈分析：`);
console.log(`  hybridSearch 是同步 CPU 计算（BM25 + ONNX 推理），`);
console.log(`  Promise.all 只能并发**等待**，不能并行**计算** ——`);
console.log(`  在单线程 Node 里收益接近 0。`);
console.log(`  真正的解法是 worker_threads 或提前算好（预检索）。`);
