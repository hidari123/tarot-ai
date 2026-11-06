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
    width: 760,
    png: true,
    /** 按亮度转 alpha */
    luminanceAlpha: { threshold: 58 },
    /** 量化到 N 色（256 = 8bit 索引色） */
    colors: 32,
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

  /* ========== 2026-11-06 第四批：全套 AI 素材 ========== */

  /** 今日之牌页背景（与主页同体系，暖紫调） */
  { src: "bg_daily.jpg", out: "bg-daily.webp", width: 1920, quality: 72 },

  /**
  /**
   * 水晶球（首页主视觉）
   * ⚠️⚠️ 为什么用 **径向遮罩** 而不是亮度转 alpha：
   *   亮度转 alpha 的思路是"黑=透明"，但水晶球**本身就是深紫色**
   *   （亮度只有 30~60）→ 无论怎么调阈值都会把球体一起吃掉
   *   （实测：threshold 12 + 开方后，球体几乎完全透明，只剩星盘和底座）。
   *
   *   → 换思路：**这个主体是居中的球+底座，外围矩形是背景**
   *     → 用**径向渐变遮罩**：中心完全不透明，边缘渐隐。
   *     → 球体（深紫）完整保留，只有黑边被羽化掉。
   * ⚠️ 为什么遮罩半径比球略大：
   *   底座比球宽（金座）→ 遮罩要包住底座，否则底座边缘会有黑边。
   */
  {
    src: "orb_crystal.jpg",
    out: "orb-crystal.webp",
    width: 760,
    quality: 80,
    /** 径向遮罩：中心不透明 → 边缘渐隐 */
    radialMask: { inner: 0.55, outer: 0.78 },
  },

  /**
   * 神谕之眼（同样用径向遮罩）
   */
  {
    src: "oracle_eye.jpg",
    out: "oracle-eye.webp",
    width: 560,
    quality: 80,
    radialMask: { inner: 0.52, outer: 0.75 },
  },

  /**
   * 三个入口图标
   * ⚠️ 为什么用**亮度转 alpha**（而不是圆形遮罩）：
   *   这些图标是黑底金线（金线在黑底上）→ 必须抠掉黑底才能放进圆形徽章。
   *   → 按亮度映射 alpha：金色线保留，黑底透明。
   */
  {
    src: "icon_daily.jpg",
    out: "icon-daily.webp",
    width: 128,
    quality: 92,
    luminanceAlpha: { threshold: 48 },
    cropToContent: { threshold: 50 },
  },
  {
    src: "icon_fortune.jpg",
    out: "icon-fortune.webp",
    width: 128,
    quality: 92,
    luminanceAlpha: { threshold: 48 },
    cropToContent: { threshold: 50 },
  },
  {
    src: "icon_oracle.jpg",
    out: "icon-oracle.webp",
    width: 128,
    quality: 92,
    luminanceAlpha: { threshold: 48 },
    cropToContent: { threshold: 50 },
  },

  /**
   * 开始占卜按钮底纹
   * ⚠️ 为什么单独出图而不是用 CSS：
   *   用户明确要求"带底纹的那种" —— CSS 只能做渐变/边框，
   *   做不出新艺术风格的卷草纹。→ AI 出图 + CSS 叠加文字。
   */
  { src: "btn_gold.jpg", out: "btn-gold.webp", width: 640, quality: 84, trim: { threshold: 14 } },

  /** 分享卡背景（竖版） */
  {
    src: "share_bg.jpg",
    out: "share-bg.webp",
    width: 720,
    quality: 80,
    trim: { threshold: 14 },
  },

  /** 空状态 / 加载态插画 */
  { src: "empty_state.jpg", out: "empty-state.webp", width: 480, quality: 82 },
  { src: "loading_state.jpg", out: "loading-state.webp", width: 480, quality: 82 },
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

  /**
   * ② 裁掉四周的空白，只留图形本身
   * ⚠️⚠️ 为什么必须在**缩放之前**做：
   *   包围盒是按像素坐标算的，如果先缩放到 128px 再按原图坐标裁，
   *   坐标系不一致 → 裁出来是空的。
   *   → 顺序必须是：裁（原始坐标）→ 缩放。
   * ⚠️⚠️ 为什么必须用 `.raw()` 手动搬运像素（而不是 extract + toBuffer 往返）：
   *   extract() 后的 buffer 重新进 pipeline 时 **alpha 通道会丢**
   *   （实测：alpha max 从 200+ 掉到 148，非零像素只剩 387 个）。
   *   → 直接在原始 raw 数据上算包围盒，然后**在同一份 raw buffer 上**
   *     做 alpha 处理与裁剪，全程不丢通道。
   */
  let rawData = null;
  let rawInfo = null;
  if (t.cropToContent || t.luminanceAlpha || t.radialMask) {
    const r = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    rawData = Buffer.from(r.data);
    rawInfo = r.info;
  }

  if (t.cropToContent && rawData && rawInfo) {
    const th = t.cropToContent.threshold ?? 45;
    let minX = rawInfo.width;
    let minY = rawInfo.height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < rawInfo.height; y++) {
      for (let x = 0; x < rawInfo.width; x++) {
        const i = (y * rawInfo.width + x) * rawInfo.channels;
        const lum = 0.299 * rawData[i] + 0.587 * rawData[i + 1] + 0.114 * rawData[i + 2];
        if (lum > th) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX > minX && maxY > minY) {
      // 留 4% 边距（避免裁到最外侧的抗锯齿像素）
      const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.04);
      const left = Math.max(0, minX - pad);
      const top = Math.max(0, minY - pad);
      const w = Math.min(rawInfo.width - left, maxX - minX + pad * 2);
      const h = Math.min(rawInfo.height - top, maxY - minY + pad * 2);
      // ⚠️ 在 raw 数据上手动裁剪（保持 alpha）
      const cropped = Buffer.alloc(w * h * rawInfo.channels);
      for (let y = 0; y < h; y++) {
        const srcOff = ((y + top) * rawInfo.width + left) * rawInfo.channels;
        rawData.copy(cropped, y * w * rawInfo.channels, srcOff, srcOff + w * rawInfo.channels);
      }
      rawData = cropped;
      rawInfo = { ...rawInfo, width: w, height: h };

      /**
       * ⚠️ 裁完后做成**正方形**（透明边填充）。
       * ⚠️ 为什么：图标要放进圆形徽章容器 → 非正方形会变形或留白不均。
       *   → 取 max(w,h) 作为边长，居中放置，两侧透明补齐。
       */
      const side = Math.max(w, h);
      const squared = Buffer.alloc(side * side * rawInfo.channels);
      const offX = Math.floor((side - w) / 2);
      const offY = Math.floor((side - h) / 2);
      for (let y = 0; y < h; y++) {
        const srcOff = y * w * rawInfo.channels;
        const dstOff = ((y + offY) * side + offX) * rawInfo.channels;
        rawData.copy(squared, dstOff, srcOff, srcOff + w * rawInfo.channels);
      }
      rawData = squared;
      rawInfo = { ...rawInfo, width: side, height: side };
    }
  }

  /**
   * ③ 按亮度转 alpha（黑/深蓝底 → 透明，金线保留）
   *
   * ⚠️⚠️ 为什么必须在**缩放之前**做：
   *   缩放会对图像做插值，细金线（1~2px）在缩到 128px 后被插值淡化，
   *   亮度掉到阈值以下 → 整条线被判成背景（实测：alpha 只剩 247 个非零像素）。
   *   → 顺序必须是：转 alpha（原始分辨率）→ 缩放。
   *   缩放时 alpha 会被正确插值 → 边缘自然柔和。
   *
   * ⚠️ 为什么要"按亮度转 alpha"而不是"黑色变透明"：
   *   AI 生成的魔法阵底色不是纯黑，是**深蓝黑**（模型给背景加蓝调）。
   *   → 简单判黑会留下一整块深蓝圆盘挡住星云。
   *   → 用亮度连续映射 alpha：暗部淡出，亮部（金线）原样保留。
   *
   * ⚠️ 为什么保留原色而不是转成纯金色：
   *   原图的金线有细微的明暗变化（刻蚀的金属质感），
   *   转成单色会丢掉那层"雕版"感。
   */
  if (t.luminanceAlpha && rawData && rawInfo) {
    const th = t.luminanceAlpha.threshold;
    for (let i = 0; i < rawData.length; i += rawInfo.channels) {
      const lum = 0.299 * rawData[i] + 0.587 * rawData[i + 1] + 0.114 * rawData[i + 2];
      /**
       * ⚠️⚠️ 为什么 alpha 用**开方**而不是线性：
       *   线性映射会把"暗紫球体"（lum≈30~60）也压到接近透明
       *   → 实测水晶球只剩星盘和底座，球体消失了。
       *   开方后：lum=30 → (30/255)² ≈ 0.014（几乎透明，纯黑区）
       *              lum=60 → ≈ 0.055（暗紫仍然可见）
       *   实际还要配合 threshold 切掉纯黑。
       * → 通用公式：alpha = ((lum - th) / (255 - th))² ，th 之上再开方。
       */
      const norm = lum <= th ? 0 : (lum - th) / (255 - th);
      const a = Math.min(255, Math.round(Math.sqrt(norm) * 255));
      rawData[i + rawInfo.channels - 1] = a;
    }
    img = sharp(rawData, {
      raw: { width: rawInfo.width, height: rawInfo.height, channels: rawInfo.channels },
    });
  }

  /**
   * ③.5 径向遮罩（水晶球 / 神谕之眼用）
   *
   * ⚠️⚠️ 为什么需要它（亮度转 alpha 的替代方案）：
   *   这两个主体的**本体就是深色**（水晶球是深紫、眼睛是紫金）
   *   → "按亮度猜透明"会连主体一起吃掉。
   *   → 但它们的**构图是确定的**：主体居中，外围矩形是纯黑背景。
   *   → 用径向渐变遮罩最稳：中心 100% 不透明，边缘渐隐到 0。
   *
   * ⚠️ 参数含义（相对半宽/半高）：
   *   inner = 中心完全不透明的半径比例
   *   outer = 完全透明的半径比例
   *   → (inner, outer) 之间线性渐变 → 边缘羽化，无硬切线
   */
  if (t.radialMask && rawData && rawInfo) {
    const { inner, outer } = t.radialMask;
    const cx = rawInfo.width / 2;
    const cy = rawInfo.height / 2;
    // 归一化距离：以图像半宽为基准（正方形图）
    const maxR = Math.min(cx, cy);
    for (let y = 0; y < rawInfo.height; y++) {
      for (let x = 0; x < rawInfo.width; x++) {
        const dx = (x - cx) / maxR;
        const dy = (y - cy) / maxR;
        const d = Math.sqrt(dx * dx + dy * dy);
        const a = d <= inner ? 1 : d >= outer ? 0 : 1 - (d - inner) / (outer - inner);
        const i = (y * rawInfo.width + x) * rawInfo.channels;
        rawData[i + rawInfo.channels - 1] = Math.round(a * 255);
      }
    }
    img = sharp(rawData, {
      raw: { width: rawInfo.width, height: rawInfo.height, channels: rawInfo.channels },
    });
  }

  // ④ 缩放到目标尺寸
  img = img.resize({
    width: t.width,
    withoutEnlargement: false,
    fit: "inside",
  });

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
