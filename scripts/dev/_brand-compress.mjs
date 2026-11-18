import sharp from "sharp";
import { statSync, writeFileSync, unlinkSync } from "node:fs";

/**
 * ⚠️ 压缩 MOIRA 品牌素材
 *
 * ⚠️ 用户需求（原文）：
 *   「我现在给你几张图 你先用png好了 可以把那个长的带文字的图 截出来一个纯logo的
 *    大小有点大 你压缩一下」
 *
 * ⚠️ 现状：源文件 5~15MB（AI 出图的高分辨率）
 * ⚠️ 目标：网页用的尺寸 + 体积合理
 */

const SRC_DIR = "public/images/brand";
const TMP_DIR = "tmp";

/**
 * ⚠️ 输出清单
 * ⚠️ 为什么要有这么多尺寸：
 *   · logo 出现在 32px(favicon) 到 512px(app icon) 不等
 *   · 一个 512px 的图给 32px 用 → 浪费带宽
 */
const TASKS = [
  /**
   * ① 纯 logo（透明底，无底板）—— 页头 / 导航 / 页脚
   */
  { src: "moira-icon-cutout.png", out: "moira-logo.png", w: 512, bg: null },
  { src: "moira-icon-cutout.png", out: "moira-logo-sm.png", w: 128, bg: null },
  { src: "moira-icon-cutout.png", out: "moira-logo-lg.png", w: 1024, bg: null },

  /**
   * ② 带底板 logo（圆角紫底）—— favicon / app icon / 标签页
   * ⚠️ 标签页的 logo 必须有底（否则深色标签页上看不清）
   */
  { src: "moira-logo-transparent.png", out: "moira-app-icon.png", w: 512, bg: null },
  { src: "moira-logo-transparent.png", out: "moira-app-icon-192.png", w: 192, bg: null },
  { src: "moira-logo-transparent.png", out: "moira-app-icon-64.png", w: 64, bg: null },

  /**
   * ③ 横向组合（图形 + 文字）—— 页头 / 分享卡片
   */
  { src: "moira-lockup-transparent.png", out: "moira-lockup.png", w: 1024, bg: null },
  { src: "moira-lockup-transparent.png", out: "moira-lockup-sm.png", w: 512, bg: null },

  /**
   * ④ 纯文字 —— 分享卡片 / 大标题
   */
  { src: "moira-wordmark-cutout.png", out: "moira-wordmark.png", w: 1024, bg: null },
];

/**
 * ⚠️ 处理：裁掉透明边 → 缩放 → 压缩
 */
for (const t of TASKS) {
  const src = `${SRC_DIR}/${t.src}`;
  const out = `${SRC_DIR}/${t.out}`;

  let img = sharp(src).ensureAlpha();

  // ① trim：裁掉四周全透明的边 → 让图形紧贴画布
  try {
    img = sharp(await img.png().toBuffer()).trim({ threshold: 2 });
  } catch {
    /* trim 失败就用原图 */
  }

  const meta = await img.metadata();
  const ratio = meta.height / meta.width;

  const buf = await img
    .resize({
      width: t.w,
      height: Math.round(t.w * ratio),
      fit: "inside",
      kernel: "lanczos3",
      withoutEnlargement: false,
    })
    .png({ compressionLevel: 9, palette: true, quality: 92 })
    .toBuffer();

  writeFileSync(out, buf);
  const m2 = await sharp(buf).metadata();
  console.log(
    `✓ ${t.out.padEnd(26)} ${m2.width}x${m2.height}  ${(statSync(out).size / 1024).toFixed(1)}KB`
  );
}

/**
 * ② WebP 版本（更小，浏览器全支持）
 */
for (const t of TASKS) {
  const out = `${SRC_DIR}/${t.out}`;
  const webp = out.replace(/\.png$/, ".webp");
  const buf = await sharp(out).webp({ quality: 88, alphaQuality: 90 }).toBuffer();
  writeFileSync(webp, buf);
  console.log(
    `✓ ${webp.replace(SRC_DIR + "/", "").padEnd(26)} ${(statSync(webp).size / 1024).toFixed(1)}KB`
  );
}

/**
 * ③ 删掉超大源文件（已压缩出成品 → 原图不再需要）
 * ⚠️ 但保留 moira-logo-transparent.png（它是最干净的 1024 版本）
 */
const KEEP = new Set(["moira-logo-transparent.png"]);
for (const f of [
  "moira-icon-cutout.png",
  "moira-lockup-transparent.png",
  "moira-lockup-white.png",
  "moira-wordmark-cutout.png",
]) {
  const p = `${SRC_DIR}/${f}`;
  if (KEEP.has(f)) continue;
  try {
    unlinkSync(p);
    console.log(`✓ 删源文件 ${f}`);
  } catch {
    /* 不存在就跳过 */
  }
}

console.log("\n=== 最终 brand 目录 ===");
const { readdirSync } = await import("node:fs");
for (const f of readdirSync(SRC_DIR)) {
  console.log(`  ${f.padEnd(30)} ${(statSync(`${SRC_DIR}/${f}`).size / 1024).toFixed(1)}KB`);
}
