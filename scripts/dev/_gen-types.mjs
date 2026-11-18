import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张占卜分类插画（神秘学 · 圆胖卡通 · 统一风格）
 *
 * ⚠️ 风格统一的关键（每个 prompt 都重复同样的风格词）：
 *   · "flat vector illustration, thick rounded shapes"
 *   · "golden yellow and cream on deep purple rounded square"
 *   · "centered, simple, iconic, no text"
 *   · 负向词："no thin lines / no outlines / no background scenery / no gradients"
 *
 * ⚠️ 为什么用 rounded square 底：
 *   · 首页是卡片网格 → 圆角方块和卡片形状一致 → 视觉统一
 *   · 和 logo 的圆角紫底呼应 ✅
 */

/** 分类 → 图形意象 */
const TYPES = [
  { id: "love", zh: "月引", en: "Love & Fate", motif: "two plump interlocking hearts" },
  { id: "career", zh: "远途", en: "Paths & Horizons", motif: "a winding mountain path with a small flag on top" },
  { id: "wealth", zh: "丰盈", en: "Wealth & Cost", motif: "a balanced golden scale with round coins" },
  { id: "crossroads", zh: "歧路", en: "Crossroads", motif: "a forked road sign splitting into two arrows" },
  { id: "tides", zh: "潮汐", en: "Tides Within", motif: "gentle ocean waves curling around a small heart" },
  { id: "morning", zh: "晨星", en: "Today's Stars", motif: "a smiling sun with a small star beside it" },
  { id: "kindred", zh: "故人", en: "Kindred & Near", motif: "two round friendly figures side by side holding hands" },
  { id: "whispers", zh: "幽微", en: "Whispers & Unknown", motif: "a single wide mystical eye with a tiny star in it" },
];

const STYLE =
  "flat vector illustration, very thick rounded chunky shapes, adorable simplified cartoon style, " +
  "golden yellow and warm cream elements on a deep purple rounded square background with subtle gradient, " +
  "centered single motif, iconic and instantly readable at small size, soft inner glow, " +
  "no text, no letters, no thin lines, no outline strokes, no background scenery, no busy detail, high contrast";

for (const t of TYPES) {
  const prompt = `${t.motif}, ${STYLE}`;
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", prompt, "shots/nt6.jpg", `shots/type-${t.id}.jpg`, "1:1"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + t.id + " " + (e.stdout || "") + (e.stderr || "").slice(0, 120));
  }
}
