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

/**
 * ── 实测参数 ──
 * ⚠️ 球心与半径怎么测出来的（scripts/dev/_dbg_grid.mjs）：
 *   ① 裁出球区域 + 叠加**坐标网格** → 肉眼看清楚球的四边在哪
 *   ② 读数：上 ≈512、下 ≈712、左 ≈400、右 ≈600
 *   ③ → 圆心 (500, 612)，半径 100
 *
 * ⚠️⚠️ 为什么不用自动检测（前面翻车 4 次）：
 *   · 亮度梯度   → 被球外光晕干扰
 *   · 最宽行     → 被**手部高亮**干扰（y=743 那行其实是手）
 *   · 低饱和判定 → 把球的暖黄色也排除了（命中率只有 47%）
 *   → 结论：**球这种"主体 + 干扰物"的图形，自动检测不可靠**
 *   → 最稳的是「网格辅助目测 + 人工读数」，一次到位 ✅
 */
const BALL = { cx: 500, cy: 612, r: 100 };

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
   * ⚠️⚠️⚠️ 2026-11-10 用户最终澄清（原文）：
   *   「不是 我的意思是球 单独抠出来 两张图 一张只改透明度 一张只抠图球」
   *
   * ⚠️ 所以背景层**只改透明度**，**完全不抠球**：
   *   · 图 A（背景层）= 小女孩整张图，alpha 统一降低 → 她手里那个球也一起变淡
   *   · 图 B（球层）  = 纯抠出来的球，实心
   *   → 两张图叠在一起 → 看到的是"她手里托着一个**发光的球**"
   *   → 而不是"球从半透明的球里冒出来" ❌
   *
   * ⚠️ 关键：图 A 里**不能挖掉球**
   *   → 她手里那个淡球 + 上面叠一个实心球 = 天然的"发光"层次 ✅
   */
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      const a = data[i + CH - 1];
      if (a === 0) continue;

      // 亮度遮罩：纯黑底（lum<25）彻底去掉
      const lum =
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const lumMask = lum <= 25 ? 0 : Math.min(1, (lum - 25) / 55);

      // ⚠️ 统一降透明度（**球区也一视同仁**）
      data[i + CH - 1] = Math.round(a * lumMask * BG_ALPHA);
    }
  }

  /**
   * ⚠️ 整图的边缘羽化（2026-11-10）
   * ⚠️ 用户反馈「截图边缘可以模糊一点 整体营造出发光的流动的感觉
   *   现在截图那块太生硬」
   *
   * ⚠️ 为什么需要：
   *   背景层是 `object-contain` 的整张图 → 它的**矩形边界**在页面上是可见的
   *   （尤其左右两侧，因为图比容器窄时会露出边缘）
   *   → 用户看到"一块生硬的图"而不是"融进背景的投影"
   *
   * ⚠️ 做法：**径向渐变 mask**（中心实、四周淡出）
   *   → 人物像"从暗处浮现"，没有硬边 ✅
   */
  const radialSvg = `<svg width="${W}" height="${H}">
    <defs>
      <radialGradient id="fade" cx="50%" cy="46%" r="62%">
        <stop offset="0%" stop-color="white" stop-opacity="1"/>
        <stop offset="52%" stop-color="white" stop-opacity="0.95"/>
        <stop offset="78%" stop-color="white" stop-opacity="0.55"/>
        <stop offset="100%" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#fade)"/>
  </svg>`;

  const fadedBuf = await sharp(data, {
    raw: { width: W, height: H, channels: CH },
  })
    .ensureAlpha()
    .composite([{ input: Buffer.from(radialSvg), blend: "dest-in" }])
    .png()
    .toBuffer();

  {
    const f = await sharp(fadedBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const buf = await sharp(f.data, {
      raw: { width: f.info.width, height: f.info.height, channels: f.info.channels },
    })
      .png({ compressionLevel: 9, palette: true, colors: 128, effort: 8 })
      .toBuffer();

    const out = join(OUT, "orb-witch-bg.png");
    writeFileSync(out, buf);
    console.log(`✓ 背景层（人物半透明 ${BG_ALPHA} + 边缘羽化）→ ${out}  ${Math.round(buf.length / 1024)}KB`);
  }
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
   * ⚠️ 球层的抠取范围 = 球本体
   * ⚠️⚠️ 2026-11-10 用户反馈「球截得不太对 有点歪了」：
   *   根因是**球心与半径都是自动检测的**，而自动检测在这个图上不可靠
   *   （亮度梯度被光晕干扰 / 最宽行被手部干扰 / 低饱和判据把暖黄的球排除）
   *   → 改成**目测定值**（见文件顶部 BALL 常量的说明）
   *
   * ⚠️ 半径略大于球本体（×1.06）→ 给后面的模糊留余量
   */
  const RX = BALL.r * 1.06;
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
       * ⚠️⚠️ 2026-11-10 用户反馈「截图边缘可以模糊一点 整体营造出发光的流动的感觉
       *   现在截图那块太生硬」
       *
       * ⚠️ 之前的做法：球内**完全不透明**，只有最外 2px 羽化
       *   → 边缘是一条**硬线** → 像贴图，不像发光 ❌
       *
       * ⚠️ 现在的做法：**边缘大幅柔化**（半径的 72%→100% 渐隐）
       *   · 中心 72% 半径内：完全不透明（球体）
       *   · 外圈 28%：平滑渐隐 → 边缘像"光晕化开"
       *   · 配合 CSS 的 conic 光带 + 呼吸 → 流动的发光球 ✅
       *
       * ⚠️ 为什么用**平滑曲线**（smoothstep）而不是线性：
       *   线性渐隐会有一圈"能看出边界"的等值线 → 还是生硬
       *   smoothstep（3t²−2t³）的斜率在两端为 0 → 完全看不出边界 ✅
       */
      const t = Math.max(0, Math.min(1, (1 - dist) / 0.28)); // 0=边缘 1=中心
      const soft = t * t * (3 - 2 * t); // smoothstep
      /** 背景（纯黑）额外去掉 */
      const isBackground = lum < 28;
      const lumMask = isBackground ? 0 : 1;

      data[i + CH - 1] = Math.round(a * lumMask * soft);
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
