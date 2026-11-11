#!/usr/bin/env node
/**
 * 小女巫水晶球 —— 单图方案（2026-11-10 第四版 · 最终）
 *
 * ⚠️⚠️⚠️ 用户最终澄清（原文）：
 *   「其实我是想都做成一张底图的 只有球在发光 然后跟着背景走
 *     现在背景移动了球移动但是 底部的小女孩还在
 *     一张图 只有球发光」
 *
 * ⚠️⚠️ 核心诉求：**只有一张图**
 *   · 背景 = 小女孩 + 球（**合成一体**），整体半透明
 *   · 只有**球的位置**发光 → 用 CSS 叠加一个发光层
 *   · 发光层跟着背景走（位置/大小由 JS 实测得出）
 *
 * ⚠️⚠️ 之前为什么会出现"两个球"：
 *   · 背景层不挖球（半透明球） + 实体层（实心球）→ 球心对齐后看起来是"球里还有球"
 *   · 用户看到的是：球移过去了，但**原来位置的小女孩还在**（背景层整体被平移，
 *     而她手里那个淡球也被带着平移了）
 *   → 根本解法：**不要两个图层**，一张图 + 一层 CSS 发光 ✅
 *
 * ⚠️ 输出的素材只有一个：
 *   `orb-witch-bg.png` —— 小女孩 + 球，整张图，半透明 + 边缘羽化
 *
 * ⚠️ 发光层的位置怎么算（JS 实测）：
 *   · 背景层：容器 112vw × 100vh，图 1024²，object-contain + object-position: center top
 *     → 渲染边长 S = min(112vw, 100vh)，图顶对齐，水平居中
 *   · 球在源图里：圆心 (500, 612)，半径 100
 *   → 图内球的显示直径 = (100×2/1024) × S
 *   → 球的显示位置 = 图左边缘 + 500/1024×S，图顶 + 612/1024×S
 *   ⚠️ 背景层被平移（--witch-shift）→ 发光层要**加上同一个偏移**
 *
 * 用法：node scripts/dev/prep-witch-single.mjs
 */

import sharp from "sharp";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "shots/gen/witch_final.png";
const OUT = "public/images/celestial";

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

/** 人物区透明度（0~1） */
const BG_ALPHA = 0.26;

/**
 * 球在源图里的位置（网格目测实测，scripts/dev/_dbg_grid.mjs）
 * · 上 512 / 下 712 / 左 400 / 右 600 → 圆心 (500, 612)，半径 100
 */
const BALL = { cx: 500, cy: 612, r: 100 };

console.log("=== 小女巫 · 单图（小女孩+球一体）===\n");

/* ── 读图 ── */
const r = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const data = Buffer.from(r.data);
const info = r.info;
const W = info.width, H = info.height, CH = info.channels;

/* ── ① 整张图降透明度（**不挖球、不抠任何部分**）── */
for (let i = 0; i < data.length; i += CH) {
  const a = data[i + CH - 1];
  if (a === 0) continue;
  const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  // 纯黑底去掉（保留球，它很亮）
  const lumMask = lum <= 25 ? 0 : Math.min(1, (lum - 25) / 55);
  data[i + CH - 1] = Math.round(a * lumMask * BG_ALPHA);
}

/* ── ② 整图边缘羽化（避免"贴图"的硬边）── */
const radialSvg = `<svg width="${W}" height="${H}">
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

const faded = await sharp(data, {
  raw: { width: W, height: H, channels: CH },
})
  .ensureAlpha()
  .composite([{ input: Buffer.from(radialSvg), blend: "dest-in" }])
  .png()
  .toBuffer();

/* ── ③ 输出 ── */
const probe = await sharp(faded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const buf = await sharp(probe.data, {
  raw: {
    width: probe.info.width,
    height: probe.info.height,
    channels: probe.info.channels,
  },
})
  .png({ compressionLevel: 9, palette: true, colors: 128, effort: 8 })
  .toBuffer();

const out = join(OUT, "orb-witch-bg.png");
writeFileSync(out, buf);
console.log(`✓ 单图（小女孩+球，半透明 ${BG_ALPHA}）→ ${out}  ${Math.round(buf.length / 1024)}KB`);

/* ── ④ 输出 CSS 定位参数 ── */
console.log(`
── 发光层定位（JS 实测时用）──
  源图 1024×1024，球心 (${BALL.cx}, ${BALL.cy})，半径 ${BALL.r}
  背景层渲染边长 S = min(112vw, 100vh)
  球显示直径 = ${BALL.r * 2}/1024 × S = ${((BALL.r * 2 / 1024) * 100).toFixed(2)}% × S
  球心视口坐标（未平移）= (图左边缘 + ${((BALL.cx / 1024) * 100).toFixed(2)}%×S, ${((BALL.cy / 1024) * 100).toFixed(2)}%×S)
  ⚠️ 平移后要加上 --witch-shift-x / --witch-shift-y
`);

/* ── ⑤ 预览：深底 + 模拟发光层 ── */
const bg = await sharp(out).toBuffer();
const bgMeta = await sharp(bg).metadata();
const S = Math.min((112 / 100) * 1024, 1024);
const imgLeft = ((112 / 100) * 1024 - S) / 2;
const d = (BALL.r * 2 / 1024) * S;
const bx = imgLeft + (BALL.cx / 1024) * S;
const by = (BALL.cy / 1024) * S;

const preview = await sharp({
  create: {
    width: bgMeta.width,
    height: bgMeta.height,
    channels: 4,
    background: { r: 13, g: 7, b: 32, alpha: 1 },
  },
})
  .composite([
    { input: bg, left: 0, top: 0 },
    {
      input: Buffer.from(
        `<svg width="${bgMeta.width}" height="${bgMeta.height}">
          <defs>
            <radialGradient id="glow" cx="${(bx / bgMeta.width) * 100}%" cy="${(by / bgMeta.height) * 100}%" r="${(d / bgMeta.width) * 100}%">
              <stop offset="0%" stop-color="rgba(255,244,205,0.85)"/>
              <stop offset="42%" stop-color="rgba(255,228,160,0.42)"/>
              <stop offset="100%" stop-color="rgba(255,200,90,0)"/>
            </radialGradient>
          </defs>
          <rect width="${bgMeta.width}" height="${bgMeta.height}" fill="url(#glow)"/>
        </svg>`
      ),
      left: 0,
      top: 0,
    },
  ])
  .png()
  .toBuffer();
writeFileSync(join("shots", "witch-single-preview.png"), preview);
console.log(`✓ 预览 → shots/witch-single-preview.png`);
