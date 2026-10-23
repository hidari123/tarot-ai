/**
 * 向量检索引擎 —— 三级降级策略
 *
 * 1. transformers.js 本地 ONNX embedding（首选，语义检索效果好，需首次下载模型）
 * 2. 特征哈希 n-gram 向量（零依赖 fallback，无网络/无模型时启用，保留"向量通道"语义）
 *    - 字符 n-gram（2/3-gram）+ 32-bit 特征哈希 → 固定维度稀疏向量 → L2 归一化
 *    - 语义能力弱于真模型，但与 BM25 的 token 粒度不同（n-gram 顺序保留），
 *      在 RRF 融合中仍能提供互补信号，且演示/面试永不翻车
 * 3. 全部失败 → 纯 BM25（hybridSearch 已处理）
 */

import { TAROT_CARDS } from "./tarot-cards";
import { KNOWLEDGE_CHUNKS, type ChunkField } from "./rag-engine";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface VectorHit {
  chunkId: string;
  cardId: string;
  cardNameZh: string;
  field: ChunkField;
  score: number;       // 余弦相似度 0~1
  snippet: string;
}

const CACHE_DIR = join(process.cwd(), "data", ".cache");
const MODEL_ID = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";

// 语义检索模式：
// "local"  = transformers.js 本地向量（默认，网络可用时）
// "hash"   = 特征哈希 n-gram 向量（零依赖 fallback）
// "off"    = 关闭向量通道（纯 BM25）
const VECTOR_MODE = process.env.RAG_VECTOR_MODE || "local";

/* ------------------------------------------------------------------ */
/* 特征哈希向量（零依赖 fallback）                                       */
/* ------------------------------------------------------------------ */

const HASH_DIM = 256;      // 向量维度
const GRAM_SIZES = [2, 3]; // n-gram 尺寸

/** 32-bit FNV-1a 哈希 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 文本 → n-gram 特征哈希向量（L2 归一化） */
export function hashEmbed(text: string): Float32Array {
  const clean = text.toLowerCase().replace(/\s+/g, " ").trim();
  const vec = new Float32Array(HASH_DIM);
  for (const n of GRAM_SIZES) {
    for (let i = 0; i <= clean.length - n; i++) {
      const gram = clean.slice(i, i + n);
      const h = fnv1a(gram);
      const idx = h % HASH_DIM;
      const sign = (h >>> 31) === 1 ? -1 : 1; // 保留符号减少碰撞冲突
      vec[idx] += sign * (1 / Math.sqrt(GRAM_SIZES.length * Math.max(clean.length - n + 1, 1)));
    }
  }
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < HASH_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < HASH_DIM; i++) vec[i] /= norm;
  return vec;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

/* ------------------------------------------------------------------ */
/* 向量索引（transformers.js 优先，哈希 fallback）                       */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipeline: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedMatrix: any = null;
let embedMode: "model" | "hash" | "off" = "off";
let embedDim = 0;
let building = false;
/** 模型加载失败标记：失败一次后本进程不再尝试（避免每次检索都卡在下载上） */
let modelLoadFailed = false;

/** 模型加载/嵌入的硬超时（transformers.js 内部 fetch 无超时，会无限挂起） */
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS) || 60_000;

async function getPipeline() {
  if (pipeline) return pipeline;
  if (modelLoadFailed) throw new Error("模型加载此前已失败，本进程降级哈希向量");
  const { pipeline: createPipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE_DIR;
  // 国内网络优先走 HF 镜像（HF_ENDPOINT 显式设置则尊重）
  if (!process.env.HF_ENDPOINT) {
    env.remoteHost = "https://hf-mirror.com";
  }
  // Node 原生 fetch 不读 HTTPS_PROXY —— 注入 undici ProxyAgent
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxyUrl) {
    try {
      const { ProxyAgent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
    } catch { /* undici 不可用则直连 */ }
  }
  // 硬超时保护：模型下载（HF 域名不可达时会无限挂起）超过时限即放弃
  pipeline = await Promise.race([
    createPipeline("feature-extraction", MODEL_ID),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`模型加载超时(${MODEL_TIMEOUT_MS}ms)，降级哈希向量`)), MODEL_TIMEOUT_MS)
    ),
  ]);
  return pipeline;
}

/** transformers.js 向量化（均值池化 + L2 归一化），全程带超时保护 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function modelEmbed(texts: string[]): Promise<Float32Array[] | null> {
  try {
    const pipe = await getPipeline();
    const run = async (): Promise<Float32Array[]> => {
      const out: Float32Array[] = [];
      const BATCH = 16;
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const res = await pipe(batch, { pooling: "mean", normalize: true });
        for (let j = 0; j < batch.length; j++) {
          out.push(new Float32Array(res[j].data));
        }
      }
      return out;
    };
    // 嵌入计算整体限时（首次含模型下载，给足 3 倍）
    return await Promise.race([
      run(),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), MODEL_TIMEOUT_MS * 3)
      ),
    ]);
  } catch {
    modelLoadFailed = true; // 失败标记：本进程后续直接走哈希
    return null;
  }
}

/** chunk 文本构造（与 warmup 脚本一致） */
function chunkText(cardNameZh: string, field: ChunkField, text: string): string {
  const label = field === "description" ? "牌面叙事" : field === "upright" ? "正位牌意" : field === "reversed" ? "逆位牌意" : "关键词";
  return `${cardNameZh} ${label}：${text}`;
}

/** 惰性构建索引：transformers 模型优先，失败降级哈希向量 */
async function ensureIndex(): Promise<boolean> {
  if (VECTOR_MODE === "off") return false;
  if (embedMatrix) return true;
  if (building) return false;

  building = true;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const texts = KNOWLEDGE_CHUNKS.map((c) => chunkText(c.cardNameZh, c.field, c.text));

    if (VECTOR_MODE === "local") {
      // ---- 尝试 transformers.js（带缓存） ----
      const cacheFile = join(CACHE_DIR, `embeddings-${MODEL_ID.replace(/\//g, "_")}.bin`);
      const metaFile = join(CACHE_DIR, `embeddings-meta.json`);
      try {
        if (existsSync(cacheFile) && existsSync(metaFile)) {
          const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
          if (meta.count === KNOWLEDGE_CHUNKS.length && meta.model === MODEL_ID && meta.mode === "model") {
            const buf = readFileSync(cacheFile);
            const f32 = new Float32Array(buf.buffer, 0, buf.length / 4);
            embedDim = meta.dim;
            embedMatrix = [];
            for (let i = 0; i < meta.count; i++) {
              embedMatrix.push(f32.slice(i * embedDim, (i + 1) * embedDim));
            }
            embedMode = "model";
            building = false;
            return true;
          }
        }
      } catch { /* 缓存损坏 → 重建 */ }
      const vecs = await modelEmbed(texts);
      if (vecs) {
        embedDim = vecs[0].length;
        embedMatrix = vecs;
        embedMode = "model";
        // 持久缓存
        try {
          const flat = new Float32Array(vecs.length * embedDim);
          vecs.forEach((v, i) => flat.set(v, i * embedDim));
          writeFileSync(cacheFile, Buffer.from(flat.buffer));
          writeFileSync(metaFile, JSON.stringify({ count: vecs.length, dim: embedDim, model: MODEL_ID, mode: "model" }));
        } catch { /* 缓存写失败不阻断 */ }
        building = false;
        return true;
      }
    }

    // ---- 哈希向量 fallback（零依赖，永不失败） ----
    const vecs = texts.map((t) => hashEmbed(t));
    embedDim = HASH_DIM;
    embedMatrix = vecs;
    embedMode = "hash";
    building = false;
    return true;
  } catch {
    building = false;
    return false;
  }
}

/** 向量语义检索 top-k */
export async function vectorSearch(query: string, topK = 5): Promise<VectorHit[]> {
  const ok = await ensureIndex();
  if (!ok || !embedMatrix) return [];

  try {
    let qVec: Float32Array;
    if (embedMode === "model") {
      const vecs = await modelEmbed([query]);
      if (!vecs) return [];
      qVec = vecs[0];
    } else {
      qVec = hashEmbed(query);
    }

    const scored = KNOWLEDGE_CHUNKS.map((chunk, i) => ({
      chunk,
      score: cosine(qVec, embedMatrix[i]),
    }))
      .filter((s) => s.score > (embedMode === "hash" ? 0.05 : 0.25))
      .sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const hits: VectorHit[] = [];
    for (const { chunk, score } of scored) {
      if (seen.has(chunk.cardId)) continue;
      if (hits.length >= topK) break;
      seen.add(chunk.cardId);
      hits.push({
        chunkId: chunk.id,
        cardId: chunk.cardId,
        cardNameZh: chunk.cardNameZh,
        field: chunk.field,
        score: Math.round(Math.max(score, 0) * 100) / 100,
        snippet: chunk.text.length > 80 ? chunk.text.slice(0, 80) + "…" : chunk.text,
      });
    }
    return hits;
  } catch {
    return [];
  }
}

/** 预热（server 启动时可选调用） */
export async function warmupVectorIndex(): Promise<void> {
  await ensureIndex();
}

