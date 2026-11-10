#!/usr/bin/env node
/**
 * 「开始占卜」按钮 —— 用户抠好的图 → 页面素材（2026-11-10）
 *
 * ⚠️ 用户要求：
 *   「不要裁切 缩小大小就好了 内部文字用深色的颜色」
 *
 * ⚠️ 输入：shots/gen/btn_final.png（用户抠好的，1280×720）
 *   · 整图（含透明区）边界 = (58,82) → (1215,638)，尺寸 1158×557
 *   · 金线框 = (60,83) → (1213,637)，尺寸 1154×555，比例 **2.08:1**
 *
 * ⚠️⚠️ 为什么**不裁切**：
 *   裁到金线框会让图的比例变成 1154:555 = 2.08:1（与原图几乎一样），
 *   但按钮容器若按别的比例渲染，object-fill 仍会拉伸。
 *   → 用户明确要"不裁切" → 保留整张图（含透明边框），
 *     用 object-contain 让它**按原比例**贴进按钮容器 → **零变形**。
 *   → 代价：按钮的"视觉框"比容器小一圈（因为图里框外有透明区），
 *     所以容器要略大于 62px 才能让视觉框看起来是 62px。
 *
 * ⚠️ 尺寸计算：
 *   视觉框高 = 容器高 × (555/720) = 容器高 × 0.771
 *   → 想要视觉框 = 62px → 容器高 = 62 / 0.771 = **80px**
 *   → 容器宽 = 80 × (1280/720) = **142px**（整图比例）
 *   → 视觉框宽 = 142 × (1158/1280) = **129px**
 *
 * 用法：node scripts/dev/prep-btn-final.mjs
 */

import sharp from "sharp";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "shots/gen/btn_final.png";
const OUT = "public/images/celestial";

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

console.log("=== 按钮素材处理（不裁切，只缩小）===\n");

/* ── ① 测量 ── */
const r = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const data = Buffer.from(r.data);
const info = r.info;
const W = info.width, H = info.height, CH = info.channels;

/** 整图（含透明区）的可见边界 */
let minX = W, maxX = 0, minY = H, maxY = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * CH;
    if (data[i + CH - 1] < 10) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

/** 金线框边界 */
let gMinX = W, gMaxX = 0, gMinY = H, gMaxY = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * CH;
    const rr = data[i], gg = data[i + 1], bb = data[i + 2];
    const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (sat > 0.42 && rr > 150 && gg > 110 && bb < 140) {
      if (x < gMinX) gMinX = x;
      if (x > gMaxX) gMaxX = x;
      if (y < gMinY) gMinY = y;
      if (y > gMaxY) gMaxY = y;
    }
  }
}

const frameW = gMaxX - gMinX + 1;
const frameH = gMaxY - gMinY + 1;
const imgW = maxX - minX + 1;
const imgH = maxY - minY + 1;

console.log(`整图可见区：${imgW}×${imgH}  位置 ${minX},${minY}`);
console.log(`金线框：${frameW}×${frameH}  位置 ${gMinX},${gMinY}`);

/* ── ② 缩放（不裁切）── */
const OUT_W = 640;
const OUT_H = Math.round((OUT_W * H) / W);

const buf = await sharp(SRC)
  .resize({ width: OUT_W, height: OUT_H, fit: "inside" })
  .png({ compressionLevel: 9, palette: true, colors: 96 })
  .toBuffer();

const out = join(OUT, "btn-start.png");
writeFileSync(out, buf);
console.log(`\n✓ ${out}  (${OUT_W}×${OUT_H}, ${Math.round(buf.length / 1024)}KB)`);

/* ── ③ 输出尺寸计算 ── */
/** 页面里"视觉框"要 62px 高 → 容器按原图比例放大 */
const VISUAL_H = 62;
const containerH = Math.round(VISUAL_H / (frameH / H));
const containerW = Math.round((containerH * W) / H);
const visualW = Math.round((containerW * frameW) / W);

console.log(`\n页面尺寸（给 page.tsx 用）：`);
console.log(`  容器：${containerW} × ${containerH}px  （object-contain → 零变形）`);
console.log(`  视觉框：${visualW} × ${VISUAL_H}px  ← 用户说的"与输入框一样高"`);
console.log(`  输入框高度：py-4(32) + text-lg 行高(28) + border(2) = 62px`);

/* ── ④ 预览 ── */
/**
 * ⚠️ sharp 的 composite 要求输入图**不大于**画布
 * ⚠️ buf 是 640×360 → 必须先缩到画布尺寸内
 */
const prevW = 200;
const prevH = Math.round((OUT_H / OUT_W) * prevW);
const scaled = await sharp(buf).resize({ width: prevW, height: prevH, fit: "inside" }).png().toBuffer();

const preview = await sharp({
  create: {
    width: prevW + 60,
    height: prevH + 40,
    channels: 4,
    background: { r: 13, g: 7, b: 32, alpha: 1 },
  },
})
  .composite([{ input: scaled, left: 30, top: 20 }])
  .png()
  .toBuffer();
writeFileSync(join("shots", "btn-final-preview.png"), preview);
console.log(`\n✓ 预览 → shots/btn-final-preview.png`);
