import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张分类图标 —— 两个风格方向
 *
 * ⚠️⚠️ 第 1 轮的失败（重要教训）：
 *   1. prompt 写了 "adorable / cute / kawaii / cartoon / mascot"
 *      → AI 理解成「萌系吉祥物」→ 潮汐/晨星/故人/幽微 全变成圆胖小怪物 ❌
 *   2. 意象描述太抽象 → AI 自由发挥
 *      → 月引 变成「日文漫画涂鸦（两只鸡）」❌
 *      → 歧路 变成「拼图」❌
 *   3. 没排除文字 → 出现假日文/假英文 ❌
 *
 * ⚠️ 修正：
 *   · 风格词全部去掉 cute/adorable/kawaii/mascot/character
 *   · 每个意象用**具体物件**描述（不是抽象概念）
 *   · 负向词统一加：no animals, no creatures, no characters, no faces,
 *     no text, no letters, no handwriting, no cartoon, no mascot
 */

/**
 * 8 个分类的意象（具体物件，避免 AI 自由发挥）
 */
const TYPES = [
  { id: "love", zh: "月引", motif: "two heart shapes intertwined with a thin ribbon spiralling around them" },
  { id: "career", zh: "远途", motif: "a winding mountain path climbing upward toward a small flag at the summit" },
  { id: "wealth", zh: "丰盈", motif: "a balance scale holding round coins on both pans" },
  { id: "crossroads", zh: "歧路", motif: "a single road splitting into two diverging arrow paths at a fork" },
  { id: "tides", zh: "潮汐", motif: "three curling ocean waves stacked in rhythm" },
  { id: "morning", zh: "晨星", motif: "a radiant sun disc with straight rays and one small four-pointed star beside it" },
  { id: "kindred", zh: "故人", motif: "two open hands reaching toward each other, fingertips almost touching" },
  { id: "whispers", zh: "幽微", motif: "an almond-shaped eye with a single small four-pointed star inside the pupil" },
];

/**
 * 方向 A：神秘学徽章（厚实金紫、无萌感）
 * ⚠️ 关键词：arcane emblem / alchemical symbol / sacred geometry / engraved
 */
const STYLE_A =
  "arcane mystical emblem icon, engraved alchemical symbol style, thick solid shapes with confident weight, " +
  "antique gold metallic linework and solid fills on a deep purple rounded square tile, " +
  "sacred geometry, occult sigil aesthetic, flat vector illustration, elegant and serious, " +
  "single centered motif, high contrast, readable at small size, " +
  "no animals, no creatures, no characters, no faces, no smile, no cute, no cartoon, no mascot, " +
  "no text, no letters, no handwriting, no japanese, no numbers, no thin lines, no background scenery";

/**
 * 方向 B：极简几何符号
 * ⚠️ 关键词：geometric / monoline-ish but thick / minimal / abstract
 */
const STYLE_B =
  "minimal geometric icon, pure abstract symbol built from simple circles arcs and straight lines, " +
  "very thick uniform stroke weight, clean modern flat vector, " +
  "warm gold on deep indigo purple rounded square tile, " +
  "restrained and sophisticated, single centered motif, " +
  "no animals, no creatures, no characters, no faces, no smile, no cute, no cartoon, no mascot, " +
  "no text, no letters, no handwriting, no japanese, no numbers, no thin lines, no background scenery";

const JOBS = [];
for (const t of TYPES) {
  JOBS.push({ file: `shots/emb-${t.id}.jpg`, prompt: `${t.motif}, ${STYLE_A}` });
  JOBS.push({ file: `shots/geo-${t.id}.jpg`, prompt: `${t.motif}, ${STYLE_B}` });
}

for (const j of JOBS) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", j.prompt, "shots/nt6.jpg", j.file, "1:1"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + j.file + " " + (e.stdout || "") + (e.stderr || "").slice(0, 120));
  }
}
