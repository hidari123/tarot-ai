import sharp from "sharp";
import { existsSync } from "node:fs";

/**
 * ⚠️ 抠图（亮度法）—— 单文件版
 * ⚠️ 用法：node scripts/dev/_clean-one.mjs <src.jpg> <out.png>
 */

const src = process.argv[2];
const out = process.argv[3];
const TARGET = { r: 240, g: 205, b: 115 };

if (!existsSync(src)) {
  console.log("✗ 缺 " + src);
  process.exit(1);
}

const { data, info } = await sharp(src)
  .resize(1024, 1024, { fit: "fill" })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const W = info.width;
const H = info.height;
const CH = info.channels;

const samples = [];
for (const [x, y] of [[2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3], [W >> 1, 2], [W >> 1, H - 3], [2, H >> 1], [W - 3, H >> 1]]) {
  const i = (y * W + x) * CH;
  samples.push(data[i] * 0.21 + data[i + 1] * 0.72 + data[i + 2] * 0.07);
}
samples.sort((a, b) => a - b);
const bgL = samples[Math.floor(samples.length / 2)];

const TH = bgL + 45;
const FADE = 30;
const n = W * H;
const outBuf = Buffer.alloc(n * 4);

for (let i = 0; i < n; i++) {
  const r = data[i * CH];
  const g = data[i * CH + 1];
  const b = data[i * CH + 2];
  const lum = r * 0.21 + g * 0.72 + b * 0.07;
  let alpha = (lum - (TH - FADE)) / (FADE * 2);
  alpha = Math.max(0, Math.min(1, alpha));
  if (alpha <= 0.01) {
    outBuf[i * 4] = 0;
    outBuf[i * 4 + 1] = 0;
    outBuf[i * 4 + 2] = 0;
    outBuf[i * 4 + 3] = 0;
  } else {
    const t = Math.max(0, Math.min(1, (lum - bgL) / 150 + 0.6));
    outBuf[i * 4] = Math.round(TARGET.r * t);
    outBuf[i * 4 + 1] = Math.round(TARGET.g * t);
    outBuf[i * 4 + 2] = Math.round(TARGET.b * t);
    outBuf[i * 4 + 3] = Math.round(255 * alpha);
  }
}

const trimmed = await sharp(outBuf, { raw: { width: W, height: H, channels: 4 } })
  .trim({ threshold: 8 })
  .png()
  .toBuffer();

const tm = await sharp(trimmed).metadata();
const pad = Math.round(Math.max(tm.width, tm.height) * 0.08);

await sharp(trimmed)
  .resize({ width: 512 - pad * 2, height: 512 - pad * 2, fit: "inside", kernel: "lanczos3" })
  .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(out);

console.log(`✓ ${out} (bgL=${Math.round(bgL)})`);
