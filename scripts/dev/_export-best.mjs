import sharp from "sharp";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * ⚠️ 终版导出（2026-11-19 · 修版）
 *
 * ⚠️⚠️ 用户最终指定：
 *   ① 月引   ← v6-w-love        （爱心+缎带）
 *   ② 远途   ← v5-k-career      （实心山+星）
 *   ③ 丰盈   ← v6-t-wealth      （实心天平）
 *   ④ 歧路   ← v6-v-crossroads  （交叉箭）
 *   ⑤ 潮汐   ← v6-u-tides       （月+海）
 *   ⑥ 晨星   ← line-a-morning   （太阳）
 *   ⑦ 故人   ← k1               （双环）
 *   ⑧ 幽微   ← v3-d-whispers    （眼睛+星）
 *
 * ⚠️⚠️ **全部去框**（用户明确：「所有的都要去掉框」）
 *
 * ⚠️⚠️ **不再做任何颜色处理**
 *   → 上一版的 lift() 用 `v / TARGET[c]` 归一化再重映射 → 暗像素几乎归零
 *     → 整张图变黑 ❌
 *   → 提亮的需求**已在 _clean-icons.mjs 的抠图曲线里解决**
 *     （t = (fgL - bgL) / 105 + 0.66）→ 这里原样导出即可 ✅
 */

/** [目标名, clean 源] */
const PICKS = [
  ["love", "v6-w-love"],
  ["career", "v6-t-career"],
  ["wealth", "v6-w-wealth"],
  ["crossroads", "v6-v-crossroads"],
  ["tides", "v6-u-tides"],
  ["morning", "f1-morning2"],
  ["kindred", "k1"],
  ["whispers", "v3-d-whispers"],
];

for (const [id, src] of PICKS) {
  const clean = `shots/${src}-clean.png`;
  if (!existsSync(clean)) {
    console.log(`✗ ${id}（缺 ${clean}）`);
    continue;
  }

  // ① 去框
  let input = clean;
  const stripped = `shots/_strip-${id}.png`;
  try {
    execFileSync("node", ["scripts/dev/_strip-one.mjs", clean, stripped], { encoding: "utf-8" });
    if (existsSync(stripped)) input = stripped;
  } catch {
    /* 去框失败就用原图 */
  }

  // ② trim → 统一尺寸（**不改颜色**）
  const trimmed = await sharp(input).trim({ threshold: 12 }).png().toBuffer();
  const tm = await sharp(trimmed).metadata();
  const pad = Math.round(Math.max(tm.width, tm.height) * 0.08);

  const final = await sharp(trimmed)
    .resize({
      width: 512 - pad * 2,
      height: 512 - pad * 2,
      fit: "inside",
      kernel: "lanczos3",
    })
    .extend({
      top: pad, bottom: pad, left: pad, right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp(final)
    .resize(160, 160, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90, alphaQuality: 92 })
    .toFile(`public/images/types/${id}.webp`);
  await sharp(final)
    .resize(320, 320, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(`public/images/types/${id}.png`);

  console.log(`✓ ${id} ← ${src}`);
}
