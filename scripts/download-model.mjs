/**
 * 下载 embedding 模型到项目缓存目录（多源自动降级）
 *
 * 源优先级（按实测国内速度）：
 *   1. modelscope.cn  约 0.4s  ← 最快
 *   2. hf-mirror.com  约 3.9s
 *   3. huggingface.co（需国际网络）
 *
 * 用法：node scripts/download-model.mjs
 */
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const MODEL_ID = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const CACHE_ROOT = join(process.cwd(), "data", ".cache");

// transformers.js 需要两种目录结构（斜杠 / URL 编码），都放一份保险
const TARGET_DIRS = [
  join(CACHE_ROOT, "Xenova", "all-MiniLM-L6-v2"),
  join(CACHE_ROOT, MODEL_ID.replace("/", "%2F")),
];

const SOURCES = [
  { name: "modelscope", base: `https://www.modelscope.cn/api/v1/models/${MODEL_ID}/repo?Revision=master&FilePath=` },
  { name: "hf-mirror", base: `https://hf-mirror.com/${MODEL_ID}/resolve/main/` },
  { name: "huggingface", base: `https://huggingface.co/${MODEL_ID}/resolve/main/` },
];

const FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

console.log(`下载 ${MODEL_ID}`);
console.log(`目标: ${TARGET_DIRS[0]}\n`);

async function downloadFile(source, file) {
  const res = await fetch(source.base + file, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

let lastSource = null;
const downloaded = new Map();

for (const file of FILES) {
  if (downloaded.has(file)) continue;

  const exists = TARGET_DIRS.some((d) => {
    const p = join(d, file);
    return existsSync(p) && statSync(p).size > 0;
  });
  if (exists) {
    console.log(`  ✓ 已存在 ${file}`);
    continue;
  }

  let ok = false;
  for (const source of SOURCES) {
    const t0 = Date.now();
    process.stdout.write(`  ↓ ${file} ← ${source.name} ... `);
    try {
      const buf = await downloadFile(source, file);
      downloaded.set(file, buf);
      lastSource = source.name;
      console.log(`OK ${(buf.length / 1024).toFixed(0)}KB (${Date.now() - t0}ms)`);
      ok = true;
      break;
    } catch (e) {
      console.log(`FAIL ${e.cause?.code ?? e.message}`);
    }
  }
  if (!ok) {
    console.error(`\n✗ ${file} 所有源均失败`);
    process.exit(1);
  }
}

// ---- 写入所有目标目录 ----
for (const dir of TARGET_DIRS) {
  for (const file of FILES) {
    const dest = join(dir, file);
    if (existsSync(dest) && statSync(dest).size > 0) continue;
    const buf = downloaded.get(file);
    if (!buf) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
  }
}

// ---- 校验 ----
const mainFile = join(TARGET_DIRS[0], "onnx", "model_quantized.onnx");
if (!existsSync(mainFile) || statSync(mainFile).size < 1024 * 1024) {
  console.error("✗ 模型文件校验失败（onnx 缺失或过小）");
  process.exit(1);
}

console.log(`\n✓ 模型就位（主要源：${lastSource ?? "本地缓存"}）`);
console.log(`  onnx: ${(statSync(mainFile).size / 1024 / 1024).toFixed(1)}MB`);
console.log(`  目录: ${TARGET_DIRS.join("\n        ")}`);
