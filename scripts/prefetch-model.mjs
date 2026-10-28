#!/usr/bin/env node
/**
 * 方向⑥：构建期预取 ONNX 嵌入模型
 *
 * 为什么需要：向量检索用的 Xenova/all-MiniLM-L6-v2 有 23MB，
 * 默认在容器首次启动时下载 —— 那时用户正在等占卜请求，
 * 直接表现为"第一次检索要等 30 秒"。构建期下载进镜像层，
 * 运行期零下载启动。
 *
 * 用法：MODEL_CACHE_DIR=/app/.model-cache node scripts/prefetch-model.mjs
 * 失败不致命：运行期仍会按需下载并降级（哈希向量）——降级链不删。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CACHE_DIR = process.env.MODEL_CACHE_DIR || join(process.cwd(), "data", ".cache");
const MODEL_ID = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";

mkdirSync(CACHE_DIR, { recursive: true });

console.log(`[prefetch] 模型: ${MODEL_ID}`);
console.log(`[prefetch] 缓存目录: ${CACHE_DIR}`);

try {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  env.localModelPath = CACHE_DIR;
  if (!process.env.HF_ENDPOINT) env.remoteHost = "https://hf-mirror.com";

  const t0 = Date.now();
  const extractor = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
  // 跑一次真实推理，确保权重真的落盘（而非只建目录）
  const out = await extractor("塔罗牌阵 愚者 新的开始", { pooling: "mean", normalize: true });
  const dim = out.dims?.[out.dims.length - 1] ?? 0;

  console.log(`[prefetch] ✓ 完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，向量维度 ${dim}`);

  // 校验：模型文件确实落盘
  const slug = MODEL_ID.replace(/\//g, "--");
  const found =
    existsSync(join(CACHE_DIR, slug, "onnx", "model_quantized.onnx")) ||
    existsSync(join(CACHE_DIR, ...MODEL_ID.split("/"), "onnx", "model_quantized.onnx"));
  console.log(found ? "[prefetch] ✓ 模型文件已落盘" : "[prefetch] ⚠ 未找到落盘文件（运行期将按需下载）");
} catch (e) {
  // 预取失败不阻塞构建（运行期会重试 + 降级）
  console.warn(`[prefetch] ⚠ 预取失败（不阻塞构建，运行期将按需下载或降级）: ${e?.message ?? e}`);
  process.exit(0);
}
