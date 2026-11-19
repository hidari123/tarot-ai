import sharp from "sharp";
import { existsSync } from "node:fs";

/**
 * ⚠️ 抠图 v4 —— 按**亮度**判定前景（修「图标发黑 / 图标里有黑线」）
 *
 * ⚠️⚠️⚠️ 之前的根本错误（用户反馈：「有的图标是黑色的 有的图表里面有黑色的线」）：
 *   抠图用「**色距** > 42」判定前景
 *   → 金色的**暗部**（金属阴影）和**细线**与紫底色距小 → 被判成背景
 *   → 结果：① 整块暗部变透明（看起来发黑）② 细线断成黑缝 ❌
 *
 * ⚠️ 正确的判据：**亮度**
 *   · 紫底是**深色**（亮度 ~20-60）
 *   · 金色图形是**亮色**（亮度 ~80-250），即使暗部也 > 紫底
 *   → 用「亮度明显高于背景亮度」判定 → 暗部保留、细线保留 ✅
 *
 * ⚠️ 阈值怎么定：
 *   · 估背景亮度 = 四角像素的中位数
 *   · 前景阈值 = 背景亮度 + 45（保守，避免把紫底的亮部误判）
 *   · 再配合轻微的 alpha 羽化（按亮度差连续映射）→ 边缘自然
 */

const IDS = ["love", "career", "wealth", "crossroads", "tides", "morning", "kindred", "whispers"];
const PREFIX = process.argv[3] ?? "line";
const TAGS = process.argv[2] ? [process.argv[2]] : ["a", "b", "c", "d", "e", "f"];

/** 目标金 */
const TARGET = { r: 240, g: 205, b: 115 };

async function processOne(src, out) {
  if (!existsSync(src)) return false;

  const { data, info } = await sharp(src)
    .resize(1024, 1024, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const CH = info.channels;

  // ① 估背景亮度（四角 + 四边中点的中位数）
  const samples = [];
  const pts = [
    [2, 2], [W - 3, 2], [2, H - 3], [W - 3, H - 3],
    [W >> 1, 2], [W >> 1, H - 3], [2, H >> 1], [W - 3, H >> 1],
  ];
  for (const [x, y] of pts) {
    const i = (y * W + x) * CH;
    samples.push((data[i] * 0.21 + data[i + 1] * 0.72 + data[i + 2] * 0.07));
  }
  samples.sort((a, b) => a - b);
  const bgL = samples[Math.floor(samples.length / 2)];

  const TH = bgL + 45; // 前景阈值
  const FADE = 30; // 羽化宽度

  // ② 按亮度生成 alpha（连续映射 → 边缘自然）
  const n = W * H;
  const outBuf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const r = data[i * CH];
    const g = data[i * CH + 1];
    const b = data[i * CH + 2];
    const lum = r * 0.21 + g * 0.72 + b * 0.07;

    // alpha：从 TH-FADE 到 TH+FADE 线性上升
    let alpha = (lum - (TH - FADE)) / (FADE * 2);
    alpha = Math.max(0, Math.min(1, alpha));

    if (alpha <= 0.01) {
      outBuf[i * 4] = 0;
      outBuf[i * 4 + 1] = 0;
      outBuf[i * 4 + 2] = 0;
      outBuf[i * 4 + 3] = 0;
    } else {
      // 颜色：保留原色相，但整体拉向品牌金（保持明暗层次）
      const t = Math.max(0, Math.min(1, (lum - bgL) / 150 + 0.6));
      outBuf[i * 4] = Math.round(TARGET.r * t);
      outBuf[i * 4 + 1] = Math.round(TARGET.g * t);
      outBuf[i * 4 + 2] = Math.round(TARGET.b * t);
      outBuf[i * 4 + 3] = Math.round(255 * alpha);
    }
  }

  // ③ trim → 缩放 → 居中
  // ⚠️ trim 后是 raw → 必须先编码成 PNG
  const trimmed = await sharp(outBuf, {
    raw: { width: W, height: H, channels: 4 },
  })
    .trim({ threshold: 8 })
    .png()
    .toBuffer();

  const tm = await sharp(trimmed).metadata();
  const pad = Math.round(Math.max(tm.width, tm.height) * 0.08);

  await sharp(trimmed)
    .resize({
      width: 512 - pad * 2,
      height: 512 - pad * 2,
      fit: "inside",
      kernel: "lanczos3",
    })
    .extend({
      top: pad, bottom: pad, left: pad, right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);

  return true;
}

for (const tag of TAGS) {
  for (const id of IDS) {
    const src = `shots/${PREFIX}-${tag}-${id}.jpg`;
    const out = `shots/${PREFIX}-${tag}-${id}-clean.png`;
    try {
      if (await processOne(src, out)) console.log(`✓ ${tag}/${id}`);
    } catch (e) {
      console.log(`✗ ${tag}/${id}: ${e.message.slice(0, 50)}`);
    }
  }
}
