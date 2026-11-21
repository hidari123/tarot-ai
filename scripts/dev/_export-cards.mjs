import sharp from "sharp";
import { existsSync } from "node:fs";

/**
 * ⚠️ 卡片插画定稿导出（从**原始 JPG** 重做，避免重复叠加）
 * ⚠️ ① 压暗（用户：「这些插画稍微有点亮 再暗点」）
 * ⚠️ ② 叠加深紫渐变（底部更暗 → 给叠加文字留可读性）
 */

const PICKS = [
  ["love", "cB"],
  ["career", "cC"],
  ["wealth", "cC"],
  ["crossroads", "cA"],
  ["tides", "cB"],
  ["morning", "cB"],
  ["kindred", "cA"],
  ["whispers", "cB"],
];

const OVERLAY = Buffer.from(
  `<svg width="720" height="960">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#06030f" stop-opacity="0.24"/>
        <stop offset="42%" stop-color="#06030f" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#06030f" stop-opacity="0.58"/>
      </linearGradient>
    </defs>
    <rect width="720" height="960" fill="url(#g)"/>
  </svg>`
);

for (const [id, src] of PICKS) {
  const jpg = `shots/${src}-${id}.jpg`;
  if (!existsSync(jpg)) {
    console.log(`✗ ${id}（缺 ${jpg}）`);
    continue;
  }

  // ① 压暗 + 稍降饱和
  const base = await sharp(jpg)
    .resize(720, 960, { fit: "cover", position: "centre" })
    .modulate({ brightness: 0.76, saturation: 0.9 })
    .png()
    .toBuffer();

  // ② 叠加渐变
  await sharp(base)
    .composite([{ input: OVERLAY }])
    .webp({ quality: 84, effort: 5 })
    .toFile(`public/images/cards/${id}.webp`);
  await sharp(base)
    .composite([{ input: OVERLAY }])
    .png({ quality: 90, compressionLevel: 9, palette: true })
    .toFile(`public/images/cards/${id}.png`);

  console.log(`✓ ${id} ← ${src}`);
}
