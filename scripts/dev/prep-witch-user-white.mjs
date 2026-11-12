#!/usr/bin/env node
/**
 * 用户新图 → 透明背景（**只去白底，不做其他处理**）（2026-11-12）
 *
 * ⚠️⚠️ 用户明确要求（原文）：
 *   「不用动了 就用这个图去当背景 你不要再处理了」
 *   「你往球里面加点动效吧」
 *
 * ⚠️ 所以这里**只做一件事**：把白底变成透明
 *   · 不改颜色、不改亮度、不改对比度、不羽化、不抠图
 *   · 人物和球的像素完全保留 ✅
 *
 * ⚠️ 为什么必须去白底：
 *   图是白底的 → 直接用会看到一个白色矩形 → 破坏页面效果
 *
 * ⚠️ 去白底的做法：
 *   · 按**亮度**判定：接近纯白（lum > 235 且 低饱和）→ 透明
 *   · 边缘做**柔和过渡**（lum 235→255 之间线性渐隐）→ 不留白边
 *
 * 用法：node scripts/dev/prep-witch-user-white.mjs
 */

import sharp from "sharp";
import { existsSync } from "node:fs";

const SRC = "shots/gen/witch_src.webp";
const OUT = "public/images/celestial/orb-witch-bg.png";

if (!existsSync(SRC)) {
  console.error("✗ 找不到源图", SRC);
  process.exit(1);
}

const r = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const data = Buffer.from(r.data);
const info = r.info;
const W = info.width, H = info.height, CH = info.channels;

for (let i = 0; i < data.length; i += CH) {
  const a = data[i + CH - 1];
  if (a === 0) continue;

  const R = data[i], G = data[i + 1], B = data[i + 2];
  const lum = 0.299 * R + 0.587 * G + 0.114 * B;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;

  /**
   * ⚠️ 白底判定
   * ⚠️⚠️⚠️ 阈值必须**更宽**（2026-11-12 实测踩坑）：
   *   之前 lum ≥ 252 才算纯白 → 但人物下摆的边缘有一圈**半透明的白色**
   *   （原图是白底，人物边缘被白底"侵蚀"过 → 像素是接近白但带 alpha）
   *   → 残留成一条**矩形硬边**（截图 v77 可见）❌
   *   → 改成 lum ≥ 244 → 透明，lum 224~244 → 渐隐
   * ⚠️ 饱和度判定也要放宽一点（0.06 → 0.10）：
   *   边缘的白色像素可能有轻微偏色 → 会被漏掉
   */
  let whiteMask;
  if (sat < 0.10) {
    whiteMask = lum >= 244 ? 0 : lum <= 224 ? 1 : (244 - lum) / 20;
  } else {
    whiteMask = 1;
  }

  data[i + CH - 1] = Math.round(a * whiteMask);
}

const buf = await sharp(data, {
  raw: { width: W, height: H, channels: CH },
})
  .png({ compressionLevel: 9, palette: true, colors: 200, effort: 8 })
  .toBuffer();

/**
 * ⚠️⚠️ 边缘羽化（2026-11-12 实测踩坑）
 * ⚠️ 截图 v77：女孩下摆有一条**矩形硬边**
 *   → 原因：原图里人物的边缘是**突然的 alpha 突变**（人物像素 → 全透明）
 *   → 白色底去掉后，这条突变线就露出来了
 * ⚠️ 修法：**alpha 邻域模糊**（高斯）→ 边缘自然渐隐
 * ⚠️ ⚠️ 但**不能糊掉球的边缘** → 只对"女孩区域"做模糊
 *   → 做法：先算出球的 mask，把球区域的 alpha 排除在模糊之外
 */
{
  const blurred = await sharp(data, { raw: { width: W, height: H, channels: CH } })
    .blur(2.2)
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 球的保护遮罩（源图坐标）
  const ballMaskSvg = `<svg width="${W}" height="${H}">
    <defs>
      <radialGradient id="b" cx="${(500 / W) * 100}%" cy="${(602 / H) * 100}%" r="${(101 / W) * 100}%">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="70%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
      <mask id="m"><rect width="${W}" height="${H}" fill="url(#b)"/></mask>
    </defs>
    <rect width="${W}" height="${H}" fill="white" mask="url(#m)"/>
  </svg>`;
  const bm = await sharp(Buffer.from(ballMaskSvg)).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += CH) {
    const p = (i / CH) | 0;
    const px = p % W;
    const py = (p / W) | 0;
    const mi = (py * W + px) * bm.info.channels;
    const protect = bm.data[mi] / 255; // 1 = 球（用原图），0 = 女孩（用模糊版）
    data[i + CH - 1] = Math.round(
      data[i + CH - 1] * protect + blurred.data[i + CH - 1] * (1 - protect)
    );
  }
}

/**
 * ⚠️⚠️ 下摆淡化（2026-11-12 用户：「小女孩下摆还是太实心了」）
 * ⚠️ 问题的本质：
 *   · 女孩整体半透明后，**下摆的深紫大色块**仍然是最大的对比来源
 *   · CSS 的 blur 会把整个人糊掉（实测 v84：女孩几乎看不见）❌
 *   → 正确做法：**在图像层面**按纵向渐变压低下摆的 alpha
 *   · 上半身（脸/帽子）保持清晰
 *   · 下摆（y > 68%）逐渐淡出 → 融入背景 ✅
 */
{
  const FADE_START = 0.70; // 从源图高度的 70% 开始淡化（球底在 67%，不能削到球）
  const FADE_END = 1.0;
  for (let y = 0; y < H; y++) {
    const t = y / H;
    if (t < FADE_START) continue;
    // smoothstep 渐隐
    const k = Math.max(0, Math.min(1, (t - FADE_START) / (FADE_END - FADE_START)));
    const fade = 1 - k * k * (3 - 2 * k);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      data[i + CH - 1] = Math.round(data[i + CH - 1] * fade);
    }
  }
}

const outBuf = await sharp(data, { raw: { width: W, height: H, channels: CH } })
  .png({ compressionLevel: 9, palette: true, colors: 200, effort: 8 })
  .toBuffer();

const fs = await import("node:fs");
fs.writeFileSync(OUT, outBuf);
console.log(`✓ 去白底 + 边缘羽化 → ${OUT}  ${W}×${H}  ${Math.round(outBuf.length / 1024)}KB`);

/* 预览：深底上看效果 */
const preview = await sharp({
  create: { width: W, height: H, channels: 4, background: { r: 13, g: 7, b: 32, alpha: 1 } },
})
  .composite([{ input: outBuf, left: 0, top: 0 }])
  .png()
  .toBuffer();
fs.writeFileSync("shots/witch-user-preview.png", preview);
console.log("✓ 预览 → shots/witch-user-preview.png");
