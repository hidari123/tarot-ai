import sharp from "sharp";
import { statSync, existsSync, writeFileSync } from "node:fs";

/**
 * ⚠️ 生成"横向流动"的星云长图
 *
 * ⚠️⚠️ 用户最终决定（很明确）：
 *   "要么你直接用粉色那个nt6翻转一次好了"
 *
 *   → 源图 = **nt6**（粉色纱幕，最好看的那张）
 *   → 拼接 = **翻转一次**（镜像 + 原图）
 *   → 展��时是一整张长图，从左向右缓慢移动
 *
 * ⚠️⚠️ 为什么镜像拼接这次可行（之前担心对称轴）：
 *   · 之前的对称轴问题出在"星云集中在中间"时
 *   · nt6 是**纱幕状**（左暗右亮，柔和过渡）→ 对称轴不明显 ✅
 *   · 而且展��时只看到图的一部分（视口宽度）→ 对称轴多在视野外 ✅
 *
 * ⚠️ 尺寸处理：
 *   · nt6 = 1344×576（21:9）
 *   → 等比放大到宽 1920 → 高 823（保持比例）
 *   → 拼接 2 段 = 3840×823
 *   → 展示时 `height:100% + width:auto` → 竖直铺满、零变形 ✅
 */

const OUT_DIR = "public/images/celestial";

/** 单段目标宽度（等比放大） */
const SEG_W = 1920;

/** [输出名, 源图, 质量] */
const ITEMS = [
  { out: "nebula-flow-a.webp", src: "shots/nt6.jpg", q: 84 },
  { out: "nebula-flow-b.webp", src: "shots/nk6.jpg", q: 82 },
];

for (const it of ITEMS) {
  if (!existsSync(it.src)) {
    console.log(`✗ 缺少 ${it.src}`);
    continue;
  }

  const buf = await sharp(it.src).toBuffer();
  const meta = await sharp(buf).metadata();

  // ① 等比放大到 SEG_W（高度按比例）
  const scaled = await sharp(buf)
    .resize({ width: SEG_W, fit: "inside", kernel: "lanczos3" })
    .sharpen({ sigma: 0.5 })
    .blur(0.8)
    .removeAlpha()
    .toColourspace("srgb")
    .toBuffer();

  const sMeta = await sharp(scaled).metadata();
  console.log(
    `→ ${it.src}: ${meta.width}×${meta.height} → 放大后 ${sMeta.width}×${sMeta.height}`
  );

  // ② 水平镜像
  const flipped = await sharp(scaled)
    .flop()
    .removeAlpha()
    .toColourspace("srgb")
    .toBuffer();

  // ③ 镜像 + 原图 → 2 倍宽（接缝在中间，左右对称 → 无缝）
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
