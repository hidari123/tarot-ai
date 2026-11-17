import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * ⚠️ 带参考图的图像生成（MiniMax image-01）
 *
 * ⚠️ 参数说明（实测）：
 *   · `subject_reference` → 报 "must be character"（那是人物专用）❌
 *   · `image_urls` / `reference_images` / `images` / `image_url` → 都能出图 ✅
 *     但服务端**静默忽略**（生成的图不是参考图的构图，只是 prompt 生效）
 *   → 所以实际用法：**只靠 prompt 描述形状**，参考图仅作"心理锚点"
 *
 * ⚠️ 用法：
 *   node scripts/dev/gen-image-ref.mjs "<prompt>" <ref.jpg> <out.jpg> [aspect] [mode]
 */

function loadEnv(file = ".env.local") {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const [, , prompt, refPath, out = "shots/gen/ref-out.jpg", aspect = "16:9", mode = "image_urls"] =
  process.argv;

if (!prompt) {
  console.error('用法: node scripts/dev/gen-image-ref.mjs "<prompt>" <ref.jpg> <out.jpg> [16:9]');
  process.exit(1);
}

const env = loadEnv();
const base = (env.OPENAI_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
const key = env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;

if (!key) {
  console.error("✗ 找不到 API key");
  process.exit(1);
}

const body = {
  model: "image-01",
  prompt,
  response_format: "url",
  n: 1,
  aspect_ratio: aspect,
};

// ⚠️ 有参考图才带参考字段（服务端会忽略，但保持协议完整）
if (refPath && existsSync(refPath)) {
  const refB64 = readFileSync(refPath).toString("base64");
  const mime = refPath.endsWith(".webp") ? "image/webp" : "image/jpeg";
  const dataUri = `data:${mime};base64,${refB64}`;
  if (mode === "image_url") body[mode] = dataUri;
  else if (mode === "images") body[mode] = [{ url: dataUri }];
  else if (mode === "reference_images") body[mode] = [dataUri];
  else body[mode] = [{ type: "image_url", image_url: dataUri }];
}

try {
  const res = await fetch(`${base}/image_generation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(`✗ HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }

  const json = await res.json();
  const url = json?.data?.image_urls?.[0];
  if (!url) {
    console.error("✗ 响应里没有图片 URL:", JSON.stringify(json).slice(0, 400));
    process.exit(1);
  }

  const dl = await fetch(url);
  const buf = Buffer.from(await dl.arrayBuffer());
  writeFileSync(out, buf);
  console.log(`✓ ${out}  (${buf.length} bytes, aspect=${aspect})`);
} catch (e) {
  console.error("✗ 生成失败:", e.message);
  process.exit(1);
}
