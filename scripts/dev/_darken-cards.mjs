import sharp from "sharp";
import { existsSync } from "node:fs";

/**
 * ⚠️ 卡片插画变暗（用户要求：「这些插画稍微有点亮 再暗点」）
 * ⚠️ 做法：叠加一层深紫黑渐变 + 整体降低亮度
 * ⚠️ 为什么不用「降低 webp 质量」：那会损失细节，不是变暗
 */

const IDS = ["love", "career", "wealth", "crossroads", "tides", "morning", "kindred", "whispers"];

for (const id of IDS) {
  const src = `public/images/cards/${id}.webp`;
  if (!existsSync(src)) {
    console.log(`✗ ${id}`);
    continue;
  }
  const m = await sharp(src).metadata();

  // ① 底层：整体压暗（线性调制）
  const base = await sharp(src)
    .resize(720, 960, { fit: "cover", position: "centre" })
    .modulate({ brightness: 0.78, saturation: 0.92 })
    .png()
    .toBuffer();

  // ② 叠加：底部更暗（给文字留可读性）+ 顶部微暗
  const overlay = Buffer.from(
    `<svg width="720" height="960">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#06030f" stop-opacity="0.26"/>
          <stop offset="45%" stop-color="#06030f" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="#06030f" stop-opacity="0.60"/>
        </linearGradient>
      </defs>
      <rect width="720" height="960" fill="url(#g)"/>
    </svg>`
  );

  await sharp(base)
    .composite([{ input: overlay }])
    .webp({ quality: 84, effort: 5 })
    .toFile(`public/images/cards/${id}.webp`);
  await sharp(base)
    .composite([{ input: overlay }])
    .png({ quality: 90, compressionLevel: 9, palette: true })
    .toFile(`public/images/cards/${id}.png`);

  console.log(`✓ ${id} (${m.width}x${m.height} → 已压暗)`);
}
