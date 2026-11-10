#!/usr/bin/env node
/**
 * 小女巫水晶球 —— 分层素材（2026-11-10 第二版）
 *
 * ⚠️⚠️ 用户明确的构图要求：
 *   「人物应该很大 当做背景 球以上部分应该半透明化出现在标题和副标题底部
 *     球突出出现在下方 再下方星盘文字的区域继续半透明化当做背景」
 *
 * ⚠️ 拆解成三层：
 *   ① **背景层**（人物）：整张图放大，人物**半透明** → 衬在标题/副标题/占卜师区
 *   ② **球层**（焦点）：单独抠出球 → **实心、不透明** → 突出在下方
 *   ③ **光效层**：叠在球上（conic 旋转 + 呼吸）
 *
 * ⚠️⚠️ 为什么这次**必须单独抠球**（与上一版相反）：
 *   上一版把球留在人物图里 → 球和人物是同一张图 → 无法让"人物半透明、球实心"
 *   → 用户要的正是这种**分离**（人物退后、球前移）
 *   → 所以必须抠球。
 *
 * ⚠️ 抠球的精度（这是上一版翻车的地方）：
 *   v1: 球心目测 (440,570) → 偏右下 ❌
 *   v2: 加权质心 (502,589) → 半径估 96 但含人脸 ❌
 *   v3: TH=215 → 包围盒 183×247 → 球心 (497,590) 半径 92 ✅
 *   → **最终：球心 (497, 590)，半径 92**（scripts/dev/_dbg_witch.mjs 实测）
 *
 * ⚠️ 抠图手法（不要用亮度阈值，会把球边缘啃掉）：
 *   ① 在**球心区域内**找"最亮核心"（TH=215）→ 确定球心与半径
 *   ② 以球心画椭圆（半径 ×1.08 留辉光余量）
 *   ③ 椭圆内：**用亮度做 alpha**（lum 越高越实）
 *      · 这样球的暗部边缘（亮度 40~80）也会保留 → 球是完整的球，不是缺口的圆
 *      · 椭圆外：alpha = 0
 *   ④ 椭圆边缘做羽化（0.86~1.0 渐隐）→ 融进背景
 *
 * 用法：node scripts/dev/prep-witch-layers.mjs
 */

import sharp from "sharp";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = "shots/gen/witch_final.png";
const OUT = "public/images/celestial";

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

/* ── 实测参数（scripts/dev/_dbg_witch.mjs）── */
const BALL = { cx: 497, cy: 590, r: 92 };

/** 背景层里人物的透明度（0~1） */
const BG_ALPHA = 0.24;

console.log("=== 小女巫 · 分层素材 ===\n");

/* ══════════════════════════════════════════════
 * ① 背景层：人物半透明（整张图）
 * ══════════════════════════════════════════════ */
{
  const r = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(r.data);
  const info = r.info;
  const W = info.width, H = info.height, CH = info.channels;

  /**
   * ⚠️⚠️ 2026-11-10 第三版修正：**背景层不再挖掉球**
   *   用户要求：「小女孩手里的球应该跟站位置的球重合的」
   *   → 球必须**同时存在于两层**，且**位置精确重合**
   *   → 背景层的球 = 她手里原本的球（半透明）
   *   → 实体层的球 = 凸出来的球（实心）
   *   → 两者重合 → 看起来就是"球从她手里凸出来"
   *
   * ⚠️ 关键：背景层的球虽然是半透明的，但**不能被实体球完全遮住**
   *   → 背景层 alpha 要比实体层低一档 → 会看到一圈"底下的球"轮廓
   *   → 这正是"凸出来"的手感（像球从背景里浮起）
   */
  const RX = BALL.r * 1.08;
  const RY = BALL.r * 1.04;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      const a = data[i + CH - 1];
      if (a === 0) continue;

      /**
       * ⚠️⚠️ 2026-11-10 第三次修正（用户反馈「光晕那圈太明显了」）：
       *   背景层的球之前是 `BG_ALPHA × 0.55`（半透明）→
       *   实体球边缘有一圈灰环时，背景层那半透明的球就透出来 → 双重灰环 ❌
       * → 修法：**背景层的球区完全挖掉**（alpha = 0）
       *   → 实体球是唯一可见的球 → 边缘干净 ✅
       *   → 而且实体球**完全覆盖**她手边的位置（球心重合）→ 视觉无损
       */
      const dx = (x - BALL.cx) / RX;
      const dy = (y - BALL.cy) / RY;
      if (Math.sqrt(dx * dx + dy * dy) <= 1) {
        data[i + CH - 1] = 0;
        continue;
      }

      // 亮度遮罩：纯黑底（lum<25）彻底去掉
      const lum =
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const lumMask = lum <= 25 ? 0 : Math.min(1, (lum - 25) / 55);
      data[i + CH - 1] = Math.round(a * lumMask * BG_ALPHA);
    }
  }

  const buf = await sharp(data, {
    raw: { width: W, height: H, channels: CH },
  })
    .png({ compressionLevel: 9, palette: true, colors: 128, effort: 8 })
    .toBuffer();

  const out = join(OUT, "orb-witch-bg.png");
  writeFileSync(out, buf);
  console.log(`✓ 背景层（人物半透明 ${BG_ALPHA}）→ ${out}  ${Math.round(buf.length / 1024)}KB`);
}

/* ══════════════════════════════════════════════
 * ② 球层：实心，单独抠出
 * ══════════════════════════════════════════════ */
{
  const r = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(r.data);
  const info = r.info;
  const W = info.width, H = info.height, CH = info.channels;

  /**
   * ⚠️ 球层的抠取范围 = 球本体（2026-11-10 收紧）
   * · 之前放到 r×1.10 是为了盖住背景层的球 → 但会超出球本体 → 边缘多出一圈 ❌
   * → 现在收紧到 r×1.02 / r×0.98 → 只保留球本身
   * → 背景层的球 alpha 已经降得很低（BG_ALPHA×0.55）→ 不会露边
   */
  const RX = BALL.r * 1.08;
  const RY = BALL.r * 1.04;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      const a = data[i + CH - 1];
      if (a === 0) continue;

      const lum =
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

      const dx = (x - BALL.cx) / RX;
      const dy = (y - BALL.cy) / RY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 1) {
        data[i + CH - 1] = 0; // 椭圆外 → 全透明
        continue;
      }

      /**
       * ⚠️ 椭圆内：亮度 → alpha
       * ⚠️⚠️ 2026-11-10 第三次修正（用户反馈「光晕那圈太明显了」）：
       *   之前 lumMask 是 (lum-45)/50 的**渐变**过渡带 →
       *   球的暗边（lum 45~95）会变成半透明的灰环 → 看起来像"光晕" ❌
       *
       * ⚠️ 正确做法：**球本体完全不透明，只有最外圈极窄的过渡**
       *   · lum ≥ 40 → 1（不透明）—— 球的暗边也算实心
       *   · lum < 40  → 0（透明）—— 只有真正的背景被去掉
       *   · 过渡带只有 lum 28~40 这一小段 → 不会有可见的灰环
       */
      const lumMask = lum >= 40 ? 1 : Math.max(0, (lum - 28) / 12);

      // 椭圆边缘羽化（0.96 → 1.0，极窄过渡）
      const edge = dist > 0.96 ? (1 - dist) / 0.04 : 1;

      data[i + CH - 1] = Math.round(a * lumMask * edge);
    }
  }

  // 裁到球的包围盒（含一点余量）
  const PAD = 12;
  const left = Math.max(0, BALL.cx - RX - PAD);
  const top = Math.max(0, BALL.cy - RY - PAD);
  const width = Math.min(W - left, Math.round((RX + PAD) * 2));
  const height = Math.min(H - top, Math.round((RY + PAD) * 2));

  const cropped = await sharp(data, {
    raw: { width: W, height: H, channels: CH },
  })
    .extract({ left, top, width, height })
    .png({ compressionLevel: 9, palette: true, colors: 128, effort: 8 })
    .toBuffer();

  /**
   * ⚠️⚠️ 再裁一次：裁到**球的实际不透明范围**
   * ⚠️ 为什么（用户反馈「你切的这个球有点小了」）：
   *   抠图时留了 PAD=12 的余量 → 图里球只占 84.4%
   *   → 页面上容器 = 图宽 → 球实际只有 137px（容器 162px）
   *   → 视觉上球就"缩了一圈"
   * → 修法：**输出时裁到球的不透明边界** → 球占满整张图
   *   → 页面上容器多大，球就显示多大 ✅
   */
  const probe = await sharp(cropped).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pd = probe.data;
  const pw = probe.info.width, ph = probe.info.height, pch = probe.info.channels;
  let aMinX = pw, aMaxX = 0, aMinY = ph, aMaxY = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = (y * pw + x) * pch;
      if (pd[i + pch - 1] > 24) {
        if (x < aMinX) aMinX = x;
        if (x > aMaxX) aMaxX = x;
        if (y < aMinY) aMinY = y;
        if (y > aMaxY) aMaxY = y;
      }
    }
  }
  if (aMaxX > aMinX && aMaxY > aMinY) {
    console.log(
      `  球的实际范围 ${aMinX},${aMinY} → ${aMaxX},${aMaxY}  (${aMaxX - aMinX + 1}×${aMaxY - aMinY + 1})`
    );
  }

  const buf = await sharp(cropped)
    .extract({
      left: aMinX,
      top: aMinY,
      width: aMaxX - aMinX + 1,
      height: aMaxY - aMinY + 1,
    })
    .png({ compressionLevel: 9, palette: true, colors: 128, effort: 8 })
    .toBuffer();

  const out = join(OUT, "orb-witch-ball.png");
  writeFileSync(out, buf);
  console.log(`✓ 球层（实心）→ ${out}  ${width}×${height}  ${Math.round(buf.length / 1024)}KB`);

  /* ── 预览：背景层 + 球层 叠合 ── */
  const bg = await sharp(join(OUT, "orb-witch-bg.png")).toBuffer();
  const bgMeta = await sharp(bg).metadata();
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
      { input: buf, left: Math.round(left), top: Math.round(top) },
    ])
    .png()
    .toBuffer();
  writeFileSync(join("shots", "witch-layers-preview.png"), preview);
  console.log(`✓ 预览 → shots/witch-layers-preview.png`);
}

/* ══════════════════════════════════════════════
 * ③ 输出 CSS 定位参数
 * ══════════════════════════════════════════════ */
console.log(`
── CSS 定位参数（两层用同一个坐标系 1024×1024）──
背景层（人物）：整张图
  球心在背景层内：left ${((BALL.cx / 1024) * 100).toFixed(1)}%  top ${((BALL.cy / 1024) * 100).toFixed(1)}%
球层：单独的图片，宽 = ${(RX * 2).toFixed(0)}px（1024 坐标系）
  → 在页面上，球的直径 = 容器宽 × ${((RX * 2 / 1024) * 100).toFixed(1)}%
`);
