import sharp from "sharp";
import { statSync, existsSync, writeFileSync } from "node:fs";

/**
 * ⚠️ 生成"横向流动"的星云长图（**只用 q5** · 翻转拼接）
 *
 * ⚠️ 用户选择：「5不错 先用5来进行一次当前的那种翻转拼接 替换掉现有的粉色看看效果 只用5哈」
 *
 * ⚠️ 拼接方式：原图 + 水平镜像 → 2 倍宽长图
 *   · 接缝在中间，左右对称 → 无缝 ✅
 *   · q5 是纱幕状（不是星系核心）→ 对称轴不明显 ✅
 *
 * ⚠️ 尺寸：q5 = 1280×720（16:9）
 *   → 等比放大到 1920 宽 → 高 1080 ✅（够高，铺满 900+ 屏）
 *   → 拼接 2 段 = 3840×1080
 *
 * ⚠️ 为什么用 sharp 放大而不是浏览器拉伸：
 *   浏览器拉伸会模糊 → Lanczos + 锐化保持清晰 ✅
 */

const OUT_DIR = "public/images/celestial";

/** [输出名, 源图, 质量] */
const ITEMS = [
  { out: "nebula-flow-a.webp", src: "shots/q5.jpg", q: 84 },
];

for (const it of ITEMS) {
  if (!existsSync(it.src)) {
    console.log(`✗ 缺少 ${it.src}`);
    continue;
  }

  const src = await sharp(it.src).toBuffer();
  const meta = await sharp(src).metadata();
  console.log(`→ ${it.src}: ${meta.width}×${meta.height}`);

  // ① 等比放大到宽 1920
  const scaled = await sharp(src)
    .resize({ width: 1920, fit: "inside", kernel: "lanczos3" })
    .sharpen({ sigma: 0.5 })
    .blur(0.8)
    .removeAlpha()
    .toColourspace("srgb")
    .toBuffer();

  const sMeta = await sharp(scaled).metadata();
  console.log(`  等比放大后: ${sMeta.width}×${sMeta.height}`);

  // ② 水平镜像
  const flipped = await sharp(scaled)
    .flop()
    .removeAlpha()
    .toColourspace("srgb")
    .toBuffer();

  // ③ 镜像 + 原图 → 2 倍宽
  const TOTAL_W = sMeta.width * 2;
  const out = await sharp({
    create: {
      width: TOTAL_W,
      height: sMeta.height,
      channels: 3,
      background: { r: 8, g: 6, b: 20 },
    },
  })
    .composite([
      { input: flipped, left: 0, top: 0 },
      { input: scaled, left: sMeta.width, top: 0 },
    ])
    .webp({ quality: it.q })
    .toBuffer();

  const path = `${OUT_DIR}/${it.out}`;
  writeFileSync(path, out);
  console.log(
    `✓ ${it.out}  ${TOTAL_W}×${sMeta.height}  ${(statSync(path).size / 1024).toFixed(1)}KB`
  );
}
