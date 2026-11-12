#!/usr/bin/env node
/**
 * 小女巫水晶球 —— 单图（女孩半透明 + 球实心）（2026-11-12 最终版）
 *
 * ⚠️⚠️⚠️ 用户最终需求（原文）：
 *   「不要抠图了 直接就一张图 小女孩部分半透明 球实心 你抠图会对不齐」
 *
 * ⚠️⚠️⚠️ 核心：**一张图，在像素层面区分两部分**
 *   · 女孩（帽子/脸/身体/手）→ alpha × 0.26（半透明当背景）
 *   · **球（她抱着的那颗）→ alpha 不变（实心、不透明）**
 *   → 位置天然一致（同一张图，**不存在对齐问题**）✅
 *
 * ⚠️ 为什么之前"两张图"是错的：
 *   · 图A（女孩）+ 图B（球）→ 两张图要**分别定位**才能对齐
 *   · 用户直接指出：「你抠图会对不齐」
 *   → 一张图在像素层面处理 → 不存在对齐问题 ✅
 *
 * ⚠️ 球在源图里的位置（网格目测实测，scripts/dev/_dbg_grid.mjs）：
 *   球的上/下/左/右 ≈ 512 / 712 / 400 / 600 → 圆心 (500, 612)，半径 100
 *
 * 用法：node scripts/dev/prep-witch-two-layers.mjs
 */

import sharp from "sharp";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "shots/gen/witch_final.png";
const OUT = "public/images/celestial";

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

/** 女孩部分的透明度（0~1） */
const GIRL_ALPHA = 0.26;

/** 球在源图里的位置（网格目测实测） */
const BALL = { cx: 500, cy: 612, r: 100 };
/**
 * ⚠️ 判定范围要**大于**球本体
 * ⚠️ 因为球的边缘要"渐渐变暗"（渐变带占半径的 38%）
 * → 渐变带从 r×0.62 开始，到 r×1.0 结束
 * → 判定范围必须 ≥ r×1.0，否则渐变会被截断 → 又变成硬边 ❌
 */
const BALL_R = BALL.r * 1.02;

console.log("=== 小女巫 · 单图（女孩半透明 + 球实心）===\n");

{
  const r = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(r.data);
  const info = r.info;
  const W = info.width, H = info.height, CH = info.channels;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      const a = data[i + CH - 1];
      if (a === 0) continue;

      const dx = (x - BALL.cx) / BALL_R;
      const dy = (y - BALL.cy) / BALL_R;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= 1) {
        /**
         * ⚠️⚠️ 球：**实心，但边缘渐渐变暗**（用户要求：「边缘不要锯齿 要渐渐变暗」）
         *
         * ⚠️ 之前只羽化最外 2% → 边缘是一条**硬线**（看起来像贴图）❌
         * → 改成**大半径渐变**：从 62% 半径开始平滑降到 0
         *   · 中心 62%：完全不透明（球体）
         *   · 62%→100%：**平滑渐暗**（smoothstep，斜率两端为 0 → 看不出边界）
         * → 效果：球像"一团光"，边缘化开而不是被切一刀 ✅
         *
         * ⚠️⚠️ 但只改 alpha 不够：
         *   球的边缘有一圈**暗轮廓线**（原图就有）
         *   → alpha 渐变了，但暗轮廓线的**颜色还在** → 边缘仍有一圈"壳"
         * → 解法：**颜色也一起渐变**（向背景色靠拢）
         *   · 越靠边缘 → RGB 越暗 → 与深紫底融合 → 完全看不出边界 ✅
         */
        const t = Math.max(0, Math.min(1, (1 - dist) / 0.38));
        const soft = t * t * (3 - 2 * t); // smoothstep

        // 颜色也随 soft 变暗（边缘 → 趋近深紫底色）
        data[i] = Math.round(data[i] * soft);
        data[i + 1] = Math.round(data[i + 1] * soft);
        data[i + 2] = Math.round(data[i + 2] * soft);
        data[i + CH - 1] = Math.round(a * soft);
      } else {
        // 女孩：半透明（纯黑底彻底去掉）
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const lumMask = lum <= 25 ? 0 : Math.min(1, (lum - 25) / 55);
        data[i + CH - 1] = Math.round(a * lumMask * GIRL_ALPHA);
      }
    }
  }

  /**
   * ⚠️ 边缘羽化
   * ⚠️⚠️ 但**不能**用整图的径向 mask —— 那会把**球**也羽化掉！
   *   → 只羽化**女孩部分**的边缘（球周围一圈做柔和过渡）
   *   → 实现：先算球的柔和遮罩，再用它反向保护球
   */
  const ballMaskSvg = `<svg width="${W}" height="${H}">
    <defs>
      <radialGradient id="ball" cx="${(BALL.cx / W) * 100}%" cy="${(BALL.cy / H) * 100}%" r="${(BALL_R / W) * 100}%">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="62%" stop-color="white" stop-opacity="1"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
      <mask id="m">
        <rect width="${W}" height="${H}" fill="url(#ball)"/>
      </mask>
    </defs>
    <rect width="${W}" height="${H}" fill="white" mask="url(#m)"/>
  </svg>`;

  // 球区域的"保护罩"（1 = 球，0 = 女孩）
  const ballMask = await sharp(Buffer.from(ballMaskSvg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 女孩部分的整图径向羽化
  const girlFadeSvg = `<svg width="${W}" height="${H}">
    <defs>
      <radialGradient id="fade" cx="50%" cy="46%" r="64%">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="54%" stop-color="white" stop-opacity="0.95"/>
        <stop offset="80%" stop-color="white" stop-opacity="0.5"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#fade)"/>
  </svg>`;
  const girlFade = await sharp(Buffer.from(girlFadeSvg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += CH) {
    const p = (i / CH) | 0;
    const px = p % W;
    const py = (p / W) | 0;
    const mi = (py * W + px) * ballMask.info.channels;

    // 球的保护系数（1=完全保留，0=完全交给女孩的羽化）
    const protect = ballMask.data[mi] / 255;
    const fade = girlFade.data[mi] / 255;

    // 球的 alpha = 原值（实心）
    // 女孩的 alpha = 原值 × 羽化
    // → 球附近：fade 趋近 0，但球自己不受影响
    data[i + CH - 1] = Math.round(data[i + CH - 1] * (protect + (1 - protect) * fade));
  }

  const buf = await sharp(data, {
    raw: { width: W, height: H, channels: CH },
  })
    .png({ compressionLevel: 9, palette: true, colors: 128, effort: 8 })
    .toBuffer();

  const out = join(OUT, "orb-witch-bg.png");
  writeFileSync(out, buf);
  console.log(`✓ 单图（女孩 ${GIRL_ALPHA} 半透明 + 球实心）→ ${out}  ${Math.round(buf.length / 1024)}KB`);
}

/* ── 预览 ── */
{
  const buf = await sharp(join(OUT, "orb-witch-bg.png")).png().toBuffer();
  const preview = await sharp({
    create: { width: 1024, height: 1024, channels: 4, background: { r: 13, g: 7, b: 32, alpha: 1 } },
  })
    .composite([{ input: buf, left: 0, top: 0 }])
    .png()
    .toBuffer();
  writeFileSync(join("shots", "witch-single-final.png"), preview);
  console.log(`✓ 预览 → shots/witch-single-final.png`);
}

