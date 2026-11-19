import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * ⚠️ 终版图标导出（2026-11-19 · 局部自适应抠图）
 *
 * ⚠️⚠️ 抠图第三次修法：**局部背景估计**
 *   前两版的失败：
 *   1. 色距判定 → 金色暗部/细线被判成背景 → 发黑 + 黑线
 *   2. 全局亮度阈值 → 渐变紫底产生**水平分界线** → 图形被横向切断
 *   3. 这版：32×32 块的**局部背景**（块内暗像素 25 分位）
 *      → 适应渐变 → 不再切断 ✅
 *
 * ⚠️ 密集线条区（潮汐的海浪）仍会碎 → 换用线条更疏的源
 */

/**
 * ⚠️⚠️ 源图**锁定**（用户指定，不得更换）
 * ⚠️ 用户原话：「不要换源啊」「我不让你做的事情你能不能别做啊」
 *   → 这份 PICKS 就是 c67666e 提交时的源 ✅
 *   → 任何时候**只允许改抠图算法**，不允许改这里的 id → src ✅
 */

/** [目标名, 源 jpg] */
const PICKS = [
  ["love", "v6-w-love"],
  ["career", "v5-k-career"],
  ["wealth", "v6-w-wealth"],
  ["crossroads", "v6-v-crossroads"],
  ["tides", "v6-u-tides"],
  ["morning", "f1-morning2"],
  ["kindred", "kb6"],
  ["whispers", "v3-d-whispers"],
];

const { extract } = await import("./_extract.mjs");
const sharp = (await import("sharp")).default;

for (const [id, src] of PICKS) {
  const jpg = `shots/${src}.jpg`;
  if (!existsSync(jpg)) {
    console.log(`✗ ${id}（缺 ${jpg}）`);
    continue;
  }
  const tmp = `shots/_ex-${id}.png`;
  await extract(jpg, tmp);

  await sharp(tmp)
    .resize(160, 160, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90, alphaQuality: 92 })
    .toFile(`public/images/types/${id}.webp`);
  await sharp(tmp)
    .resize(320, 320, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(`public/images/types/${id}.png`);

  console.log(`✓ ${id} ← ${src}`);
}
