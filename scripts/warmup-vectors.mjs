/**
 * 向量索引预热 —— 用真实 ONNX 模型 embed 全部 312 个知识块
 *
 * 运行：node scripts/warmup-vectors.mjs
 * 产物：data/.cache/embeddings-*.bin + embeddings-meta.json (mode: "model")
 *       之后 vector-engine 启动直接读缓存，无需再算
 */
import { pipeline, env } from "@huggingface/transformers";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TAROT_CARDS } = require("../mcp-server/tarot-cards.cjs");

const CACHE_DIR = join(process.cwd(), "data", ".cache");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// 与 vector-engine.ts 的 chunkText 保持一致
const FIELD_LABEL = {
  description: "牌面叙事",
  upright: "正位牌意",
  reversed: "逆位牌意",
  keywords: "关键词",
};

const chunks = [];
for (const card of TAROT_CARDS) {
  const fields = [
    ["description", card.description],
    ["upright", card.upright],
    ["reversed", card.reversed],
    ["keywords", card.keywords.join("、")],
  ];
  for (const [field, text] of fields) {
    chunks.push({
      id: `${card.id}:${field}`,
      cardId: card.id,
      cardNameZh: card.nameZh,
      field,
      text,
      embedText: `${card.nameZh} ${FIELD_LABEL[field]}：${text}`,
    });
  }
}
console.log(`待向量化：${chunks.length} 个知识块`);

env.cacheDir = CACHE_DIR;
env.localModelPath = CACHE_DIR;
env.allowRemoteModels = false;   // 强制离线
env.allowLocalModels = true;

console.log("加载模型（离线）…");
const t0 = Date.now();
const pipe = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
console.log(`✓ 模型加载（${Date.now() - t0}ms）`);

console.log("批量 embedding…");
const t1 = Date.now();
const vecs = [];
const BATCH = 16;
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const res = await pipe(batch.map((c) => c.embedText), { pooling: "mean", normalize: true });
  for (let j = 0; j < batch.length; j++) vecs.push(new Float32Array(res[j].data));
  process.stdout.write(`  ${Math.min(i + BATCH, chunks.length)}/${chunks.length}\r`);
}
console.log(`\n✓ 向量化完成（${Date.now() - t1}ms），维度 ${vecs[0].length}`);

// 写缓存（格式与 vector-engine.ensureIndex 读取一致）
mkdirSync(CACHE_DIR, { recursive: true });
const dim = vecs[0].length;
const flat = new Float32Array(vecs.length * dim);
vecs.forEach((v, i) => flat.set(v, i * dim));
const cacheFile = join(CACHE_DIR, `embeddings-${MODEL_ID.replace(/\//g, "_")}.bin`);
const metaFile = join(CACHE_DIR, "embeddings-meta.json");
writeFileSync(cacheFile, Buffer.from(flat.buffer));
writeFileSync(metaFile, JSON.stringify({ count: vecs.length, dim, model: MODEL_ID, mode: "model" }));
console.log(`✓ 缓存写入: ${cacheFile} (${(statSync(cacheFile).size / 1024 / 1024).toFixed(1)}MB)`);

// 验证：语义检索效果
console.log("\n语义检索验证（真实 embedding）：");
const QUERIES = [
  "心里放不下他",
  "感情出现裂痕怎么办",
  "事业上想突破",
  "钱的问题令人焦虑",
];
for (const q of QUERIES) {
  const out = await pipe([q], { pooling: "mean", normalize: true });
  const qv = new Float32Array(out[0].data);
  const scored = chunks.map((c, i) => {
    let s = 0;
    for (let k = 0; k < qv.length; k++) s += qv[k] * vecs[i][k];
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  // 每牌去重后取 top3
  const seen = new Set();
  const top = [];
  for (const { c, s } of scored) {
    if (seen.has(c.cardId)) continue;
    seen.add(c.cardId);
    top.push(`${c.cardNameZh}(${s.toFixed(2)})`);
    if (top.length >= 3) break;
  }
  console.log(`  "${q}" → ${top.join("、")}`);
}
console.log("\n✓ 预热完成，真实语义向量通道已就绪");
