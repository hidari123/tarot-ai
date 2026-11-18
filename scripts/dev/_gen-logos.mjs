import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 Moria 的 logo 概念图（4 个方向）
 * ⚠️ 品牌调性：深空紫 + 金、神秘学、精致、可缩放
 */

/**
 * ⚠️ prompt 的关键（吸取出图经验）：
 * · 描述**风格**而不是描述"logo"→ AI 会画成插画/图表
 * · 强调 "minimal", "vector", "flat", "monoline", "negative space"
 * · 强调 "isolated on solid background", "no text"（要文字就单独排）
 * · 强调单一配色（否则 AI 会加渐变彩虹）
 */

const CONCEPTS = [
  {
    file: "shots/logo-1.png",
    p: "minimal vector logo mark, a single elegant hexagonal arcane symbol with a stylized eye at its center, thin monoline strokes, flat single color metallic gold on a deep indigo purple background, geometric precision, occult symbolism, high contrast, isolated centered composition, no text, no letters, no gradient",
  },
  {
    file: "shots/logo-2.png",
    p: "minimal vector logo mark, an abstract crescent moon with a single small four pointed star nestled inside the curve, ultra simple monoline geometry, flat single color warm gold on a very dark violet background, elegant mystical but modern, isolated centered, generous negative space, no text, no letters",
  },
  {
    file: "shots/logo-3.png",
    p: "minimal vector logo mark, three thin vertical lines of varying length converging into a single point, like stylized fate threads or spindle, monoline stroke, flat single color pale gold on deep black purple, sophisticated abstract geometry, isolated centered, lots of negative space, no text, no letters",
  },
  {
    file: "shots/logo-4.png",
    p: "minimal vector logo mark, a stylized compass rose made of four elongated diamond points with a small circle at the center, thin monoline, flat single color antique gold on deep purple black, precise occult instrument aesthetic, isolated centered, no text, no letters, no gradient",
  },
];

for (const c of CONCEPTS) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", c.p, "shots/nt6.jpg", c.file, "1:1"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + (e.stdout || "") + (e.stderr || "").slice(0, 150));
  }
}
