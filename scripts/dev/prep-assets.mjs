#!/usr/bin/env node
/**
 * AI 素材后处理（2026-11-06）
 *
 * ⚠️ 为什么需要这一步：
 *   MiniMax image-01 的输出有几个"不能直接用"的问题：
 *     ① 牌背图带**白边**（模型把牌画在白底上）→ 必须裁掉
 *     ② 头像图有**暗角背景** → 直接用会是方形硬边，需要圆形遮罩或羽化
 *     ③ JPEG 有块状伪影 + 体积大 → 转 WebP
 *     ④ 尺寸固定 1024² → 我们只需要 128~256px（省流量）
 *
 * ⚠️ 为什么用 sharp 而不是 PS：
 *   这些都是**确定性的批量处理**（裁切 / 缩放 / 转码），
 *   sharp 更快、可写进 CI、无需人工操作。
 *   PS 留给"需要人眼判断的调色"（用户手动做的事）。
 *
 * 用法：node scripts/dev/prep-assets.mjs
 */

import sharp from "sharp";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = "shots/gen";
const OUT = "public/images/celestial";

if (!existsSync(SRC)) {
  console.error(`✗ 找不到素材目录 ${SRC}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

/**
 * 处理清单
 * ⚠️ 每项的 crop/fit 是**人工调过的**（看生成结果决定的），不是通用参数。
 */
const TASKS = [
  /**
   * 背景：三张页面背景
   * ⚠️ 为什么 resize 到 1920 宽（比原图 1280 大）：
   *   CSS background-size:cover 会把 1280 拉伸到 1920+ → 轻微发虚。
   *   放大到 1920 让它有 1.5x 余量（retina 屏 @2x 才不虚）。
   */
  {
    src: "bg_home.jpg",
    out: "bg-home.webp",
    width: 1920,
    quality: 72,
  },
  { src: "bg_fortune.jpg", out: "bg-fortune.webp", width: 1920, quality: 72 },
  { src: "bg_oracle.jpg", out: "bg-oracle.webp", width: 1920, quality: 72 },

  /**
   * 移动端小图（480px）
   * ⚠️ 为什么单独出：手机流量敏感，1920 的图在手机上纯属浪费。
   */
  { src: "bg_home.jpg", out: "bg-home-sm.webp", width: 640, quality: 66 },

  /**
   * 魔法阵
   * ⚠️ 为什么用 **PNG8（量化调色板）** 而不是 PNG24 / WebP：
   *   · PNG24 + alpha = 283 KB（alpha 通道无损存储）
   *   · WebP + alpha = 250 KB（alpha 同样基本无损）
   *   · **PNG8 量化到 64 色调色板** → 约 40~60 KB
   *     金色线条的颜色数很少（本来就只有金→黑这一个色相），
   *     量化几乎无损 → 体积降 5 倍，观感一致。
   *
   * ⚠️ 为什么要"按亮度转 alpha"而不是"黑色变透明"：
   *   AI 生成的魔法阵底色不是纯黑，是**深蓝黑**（模型给背景加蓝调）。
   *   → 简单判黑会留下一整块深蓝圆盘挡住星云。
   *   → 用亮度连续映射 alpha：暗部淡出，亮部（金线）原样保留。
   */
  {
    src: "magic_circle.jpg",
    out: "magic-circle.png",
    width: 900,
    png: true,
    /** 按亮度转 alpha */
    luminanceAlpha: { threshold: 58 },
    /** 量化到 N 色（256 = 8bit 索引色） */
    colors: 64,
  },

  /**
   * 牌背
   * ⚠️ 为什么需要裁白边：
   *   模型把牌画在**白底**上（左右和上下都有白边）。
   *   → 用 trim() 自动裁掉纯白边。
   */
  {
    src: "card_back.jpg",
    out: "card-back.webp",
    width: 480,
    quality: 82,
    trim: { threshold: 12 },
  },

  /**
   * 五个占卜师头像
   * ⚠️ 为什么用圆形裁切（而不是方形）：
   *   头像是圆形徽章（与现在的 PersonaOrb 圆形容器一致）→
   *   方形图放圆形容器里会有四角露出的黑边。
   * → 圆形 alpha 遮罩。
   */
  { src: "p_moon.jpg", out: "persona-moon.webp", width: 256, quality: 84, circle: true },
  { src: "p_heart.jpg", out: "persona-heart.webp", width: 256, quality: 84, circle: true },
  { src: "p_quill.jpg", out: "persona-quill.webp", width: 256, quality: 84, circle: true },
  { src: "p_compass.jpg", out: "persona-compass.webp", width: 256, quality: 84, circle: true },
  { src: "p_druid.jpg", out: "persona-druid.webp", width: 256, quality: 84, circle: true },
];

for (const t of TASKS) {
  const srcPath = join(SRC, t.src);
  if (!existsSync(srcPath)) {
    console.warn(`⚠ 跳过（源文件不存在）: ${t.src}`);
    continue;
  }

  let img = sharp(srcPath);

  // ① 自动裁掉白边（只对牌背）
  if (t.trim) {
    img = img.trim({
      threshold: t.trim.threshold,
      background: "#ffffff",
    });
  }

  // ② 缩放
  img = img.resize({
    width: t.width,
    withoutEnlargement: false,
    fit: "inside",
  });

  // ③ 魔法阵：按亮度转 alpha（黑/深蓝底 → 透明，金线保留）
  if (t.luminanceAlpha) {
    /**
     * ⚠️ 为什么要"按亮度转 alpha"而不是"黑色变透明"：
     *   AI 生成的魔法阵底色不是纯黑，是**深蓝黑**（模型给背景加蓝调）。
     *   → 简单判黑会留下一整块深蓝圆盘挡住星云。
     *   → 用亮度连续映射 alpha：暗部淡出，亮部（金线）原样保留。
     *
     * ⚠️ 为什么保留原色而不是转成纯金色：
     *   原图的金线有细微的明暗变化（刻蚀的金属质感），
     *   转成单色会丢掉那层"雕版"感。
     */
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = Buffer.from(data);
    const th = t.luminanceAlpha.threshold;
    for (let i = 0; i < px.length; i += info.channels) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      // 低于阈值 → 全透明；高于阈值 → 线性映射到不透明度
      const a = lum <= th ? 0 : Math.min(255, Math.round(((lum - th) / (255 - th)) * 255));
      px[i + info.channels - 1] = a;
    }
    img = sharp(px, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    });
  }

  // ④ 圆形遮罩（头像）
  if (t.circle) {
    const size = t.width;
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${
        size / 2
      }" fill="#fff"/></svg>`
    );
    img = sharp(
      await img
        .resize(size, size, { fit: "cover", position: "top" })
        .toBuffer()
    ).composite([{ input: mask, blend: "dest-in" }]);
  }

  const outPath = join(OUT, t.out);
  if (t.png) {
    /**
     * ⚠️ colors 参数让 sharp 走 PNG8（索引色）路径 → 体积降 5 倍。
     * ⚠️ 必须放在最后一步（在 alpha 处理之后），否则量化会破坏 alpha 梯度。
     */
    await img
      .png({
        compressionLevel: 9,
        palette: true,
        ...(t.colors ? { colors: t.colors } : {}),
      })
      .toFile(outPath);
  } else {
    await img.webp({ quality: t.quality ?? 80, effort: 6 }).toFile(outPath);
  }

  // 用 stat 读体积（sharp 的 toBuffer({resolveWithObject}) 返回 info.size）
  const { size: bytes } = await import("node:fs").then((fs) =>
    fs.promises.stat(outPath)
  );
  console.log(`✓ ${outPath}  (${Math.round(bytes / 1024)} KB)`);
}
