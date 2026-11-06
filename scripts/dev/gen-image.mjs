#!/usr/bin/env node
/**
 * AI 图像生成（MiniMax image-01）· 2026-11-06
 *
 * ⚠️ 为什么需要这个脚本：
 *   CSS 渐变做不出"絮状星云结构"——纯渐变的破绽就是"太干净"。
 *   AI 生成的星云有真实的纤维走向和颗粒感 → 这是"背景看起来像照片"的关键。
 *
 * ⚠️ MiniMax 图像模型 ≠ MiniMax-M3（文本模型）：
 *   文本模型走 /v1/chat/completions；图像模型走 /v1/image_generation。
 *   两者共用同一个 API key，但端点与模型名不同。
 *
 * 用法：
 *   node scripts/dev/gen-image.mjs "<prompt>" <out.jpg> [aspect]
 *   aspect: 16:9 | 1:1 | 21:9 | 9:16（默认 16:9）
 *
 * ⚠️ key 从 .env.local 读（OPENAI_BASE_URL + DEEPSEEK_API_KEY），
 *   不写死在代码里。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** 从 .env.local 读配置（不引 dotenv 依赖） */
function loadEnv(file = ".env.local") {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const [, , prompt, out = "shots/gen/out.jpg", aspect = "16:9"] = process.argv;

if (!prompt) {
  console.error('用法: node scripts/dev/gen-image.mjs "<prompt>" <out.jpg> [16:9]');
  process.exit(1);
}

const env = loadEnv();
const base = (env.OPENAI_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
const key = env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;

if (!key) {
  console.error("✗ 找不到 API key（.env.local 的 DEEPSEEK_API_KEY 或环境变量）");
  process.exit(1);
}

/**
 * ⚠️ aspect_ratio 支持哪些值由服务端决定；
 *   实测 image-01 接受 "16:9" / "1:1" / "21:9" / "9:16"。
 *   若服务端不支持，会回落到 1024×1024（实测默认值）。
 */
const body = {
  model: "image-01",
  prompt,
  response_format: "url",
  n: 1,
  aspect_ratio: aspect,
};

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

  // 下载（OSS 的 URL 带签名参数，必须整段传）
  const dl = await fetch(url);
  const buf = Buffer.from(await dl.arrayBuffer());
  writeFileSync(out, buf);
  console.log(`✓ ${out}  (${buf.length} bytes, aspect=${aspect})`);
} catch (e) {
  console.error("✗ 生成失败:", e.message);
  process.exit(1);
}
