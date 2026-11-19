import sharp from "sharp";
import { existsSync } from "node:fs";

/**
 * ⚠️ 抠图 v8 —— **放大 + 全局阈值 + 形态学**（最终版）
 *
 * ⚠️⚠️⚠️ 走过的弯路（7 版）：
 *   1. 色距判定 → 发黑 + 黑线
 *   2. 全局亮度阈值（不放大）→ 渐变底产生水平切断
 *   3. 局部背景估计（32px 块）→ 7/8 好，但小图形（歧路）碎裂
 *   4. 饱和度判定 → 紫底饱和度也高 → 全黑
 *   5. 局部 + 闭运算 → 实心图形有棋盘格纹理
 *   6. 局部 8px 块 → 全是虚线碎屑
 *   7. 先放大 + 局部 16px → 虚线描边
 *
 * ⚠️⚠️ 这版的关键洞察：
 *   **放大 + 全局阈值** 就够了
 *   · 放大的作用：把图形放大 → 图形内部的像素亮度不再接近背景
 *     → 用**全局阈值**（背景亮度 + 30）就能干净分开
 *   · 再用形态学闭运算 + 填洞 → 实心区域变完整 ✅
 *   · 不再用局部估计 → 没有棋盘格纹理 ✅
 */

const TARGET = { r: 240, g: 205, b: 115 };

export async function extract(src, out) {
  if (!existsSync(src)) return false;

  // ① 读原图，粗定位图形 bbox
  const orig = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const OW = orig.info.width;
  const OH = orig.info.height;
  const OCH = orig.info.channels;

  const bgSamples = [];
  for (const [x, y] of [[2, 2], [OW - 3, 2], [2, OH - 3], [OW - 3, OH - 3], [OW >> 1, 2], [OW >> 1, OH - 3]]) {
    const i = (y * OW + x) * OCH;
    bgSamples.push(orig.data[i] * 0.21 + orig.data[i + 1] * 0.72 + orig.data[i + 2] * 0.07);
  }
  bgSamples.sort((a, b) => a - b);
  const bgL = bgSamples[Math.floor(bgSamples.length / 2)];

  let minX = OW, minY = OH, maxX = 0, maxY = 0, found = 0;
  for (let y = 0; y < OH; y++) {
    for (let x = 0; x < OW; x++) {
      const i = (y * OW + x) * OCH;
      const lum = orig.data[i] * 0.21 + orig.data[i + 1] * 0.72 + orig.data[i + 2] * 0.07;
      if (lum > bgL + 38) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found++;
      }
    }
  }
  if (!found) return false;

  const padX = Math.round((maxX - minX) * 0.08) + 4;
  const padY = Math.round((maxY - minY) * 0.08) + 4;
  const left = Math.max(0, minX - padX);
  const top = Math.max(0, minY - padY);
  const width = Math.min(OW - left, maxX - minX + padX * 2);
  const height = Math.min(OH - top, maxY - minY + padY * 2);

  // ② 裁出并放大（图形变大 → 全局阈值就准）
  const Z = 900;
  const zoomed = await sharp(src)
    .extract({ left, top, width, height })
    .resize(Z, Z, { fit: "fill", kernel: "lanczos3" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = zoomed.info.width;
  const H = zoomed.info.height;
  const CH = zoomed.info.channels;
  const n = W * H;

  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = zoomed.data[i * CH] * 0.21 + zoomed.data[i * CH + 1] * 0.72 + zoomed.data[i * CH + 2] * 0.07;
  }

  // ③ 全局阈值（放大后足够准）
  const TH = 28;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = lum[i] - bgL > TH ? 1 : 0;

  // ④ 形态学：闭运算（补细缝）→ 填洞（补内部）
  const closed = close(bin, W, H, 2);
  const filled = fillHoles(closed, W, H);

  // ⑤ 输出
  const outBuf = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    if (!filled[i]) {
      outBuf[i * 4] = 0; outBuf[i * 4 + 1] = 0; outBuf[i * 4 + 2] = 0; outBuf[i * 4 + 3] = 0;
      continue;
    }
    const diff = lum[i] - bgL;
    const t = Math.max(0.58, Math.min(1, diff / 150 + 0.65));
    outBuf[i * 4] = Math.round(TARGET.r * t);
    outBuf[i * 4 + 1] = Math.round(TARGET.g * t);
    outBuf[i * 4 + 2] = Math.round(TARGET.b * t);
    outBuf[i * 4 + 3] = 255;
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

  return true;
}

function close(mask, W, H, r = 2) {
  let m = mask;
  for (let k = 0; k < r; k++) {
    const d = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!m[y * W + x]) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny >= 0 && ny < H && nx >= 0 && nx < W) d[ny * W + nx] = 1;
          }
      }
    m = d;
  }
  for (let k = 0; k < r; k++) {
    const e = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let all = 1;
        for (let dy = -1; dy <= 1 && all; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= H || nx < 0 || nx >= W || !m[ny * W + nx]) { all = 0; break; }
          }
        e[y * W + x] = all;
      }
    m = e;
  }
  return m;
}

function fillHoles(mask, W, H) {
  const outside = new Uint8Array(W * H);
  const stack = [];
  for (let x = 0; x < W; x++)
    for (const y of [0, H - 1])
      if (!mask[y * W + x] && !outside[y * W + x]) { outside[y * W + x] = 1; stack.push(y * W + x); }
  for (let y = 0; y < H; y++)
    for (const x of [0, W - 1])
      if (!mask[y * W + x] && !outside[y * W + x]) { outside[y * W + x] = 1; stack.push(y * W + x); }
  while (stack.length) {
    const i = stack.pop();
    const y = (i / W) | 0, x = i % W;
    for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
      const j = ny * W + nx;
      if (mask[j] || outside[j]) continue;
      outside[j] = 1;
      stack.push(j);
    }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] || !outside[i] ? 1 : 0;
  return out;
}
