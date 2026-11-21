import sharp from "sharp";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * ⚠️ 把清理后的图标导出到 public/images/types/
 * ⚠️ 用法：node scripts/dev/_export-types.mjs <tag> <cleanedSuffix>
 *   例：node scripts/dev/_export-types.mjs l2 a   → shots/l2-<id>-clean.png
 */

const TAG = process.argv[2] ?? "l2";
const SUFFIX = process.argv[3] ?? "a";
const OUT_DIR = "public/images/types";

const IDS = ["love", "career", "wealth", "crossroads", "tides", "morning", "kindred", "whispers"];

for (const id of IDS) {
  const src = `shots/${TAG}-${SUFFIX}-${id}-clean.png`;
  const alt = `shots/${TAG}-${id}-clean.png`;
  const use = existsSync(src) ? src : existsSync(alt) ? alt : null;
  if (!use) {
    console.log(`✗ ${id}（找不到 ${src}）`);
    continue;
  }
  try {
    await sharp(use)
      .resize(160, 160, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 90, alphaQuality: 92 })
      .toFile(join(OUT_DIR, `${id}.webp`));
    // 同时留一份 PNG（大图用）
    await sharp(use)
      .resize(320, 320, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(join(OUT_DIR, `${id}.png`));
    console.log(`✓ ${id}`);
  } catch (e) {
    console.log(`✗ ${id}: ${e.message.slice(0, 60)}`);
  }
}
