import { execFileSync } from "node:child_process";

/**
 * ⚠️ 「故人」单独重出 —— 前 6 轮的握手都画不好
 *
 * ⚠️⚠️ 为什么握手老是失败：
 *   · 「两只手」是 AI 最难画的题材 → 每次都变成怪东西或加方框
 *   · 用户明确说「第七张还是都不行」
 *
 * ⚠️ 换意象（保持「故人 / 朋友」语义，但更好画）：
 *   · 两个**相扣的圆环**（像交握的手，但几何化）← 最好画
 *   · 一棵**双生树**（两棵树缠在一起）
 *   · **两只鸟**相对（but AI 画鸟会变萌系）
 *   · **一条绳结**（结绳 = 联结）
 *
 * ⚠️ 这次出 4 个候选让用户挑
 */

const CANDS = [
  {
    file: "shots/k1.jpg",
    motif:
      "two simple interlocking rings overlapping, drawn with VERY THICK bold strokes, " +
      "absolutely no hands and no fingers, just two clean circles linked together",
  },
  {
    file: "shots/k2.jpg",
    motif:
      "two tree trunks growing side by side and twisting around each other into one trunk, " +
      "drawn with VERY THICK bold strokes, very simple and minimal",
  },
  {
    file: "shots/k3.jpg",
    motif:
      "a single simple overhand knot made of one continuous rope, drawn with VERY THICK bold strokes, " +
      "absolutely no hands, just the knot itself",
  },
  {
    file: "shots/k4.jpg",
    motif:
      "two simple circles overlapping with a small connecting arc between them, " +
      "like two friends side by side, drawn with VERY THICK bold strokes, extremely minimal",
  },
];

const STYLE =
  "flat 2D vector icon, completely flat with no volume no shading no 3d, " +
  "single flat antique gold color, only two or three big rounded shapes, " +
  "flat solid deep purple background, " +
  "the shape floats alone in the exact center with completely empty deep purple space on all four sides, " +
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge, " +
  "there is absolutely nothing else in the picture besides the single shape, " +
  "no border, no outline box, no decorative corners, " +
  "no text, no letters, no hands, no fingers, no people, " +
  "no thin lines, no fine details, no gradient, no shadow, no glow";

for (const c of CANDS) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", `${c.motif}, ${STYLE}`, "shots/nt6.jpg", c.file, "1:1"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + c.file + " " + (e.stdout || "") + (e.stderr || "").slice(0, 120));
  }
}
