import { execFileSync } from "node:child_process";

/**
 * ⚠️ 「故人」终版 —— 拱桥/叶子方向多出几张让用户挑
 *
 * ⚠️ 要求：和现有 8 张图标**完全一致**的画法
 *   （金色粗线 / 实心剪影、扁平、居中占 70%、无框、无底座）
 */

const JOBS = [
  {
    file: "shots/kb1.jpg",
    motif:
      "a single elegant stone arch bridge with two small square piers, one large arch opening, " +
      "a simple railing line on top, drawn with VERY THICK bold strokes, " +
      "completely hollow (outline only, not filled), very simple and minimal, only two or three big shapes",
  },
  {
    file: "shots/kb2.jpg",
    motif:
      "two simple symmetrical leaf shapes meeting at the base forming a heart-like symmetry, " +
      "each leaf with a single center vein line, drawn with VERY THICK bold strokes, " +
      "completely hollow (outline only, not filled), very simple and minimal, only two shapes",
  },
  {
    file: "shots/kb3.jpg",
    motif:
      "a single arched bridge seen from the side, its deck curving gently, resting on two simple piers, " +
      "drawn as a bold solid silhouette shape (filled in), very simple and minimal, " +
      "only two or three big shapes",
  },
  {
    file: "shots/kb4.jpg",
    motif:
      "two simple leaf shapes side by side, each drawn as a bold solid silhouette (filled in), " +
      "with one vein line, leaning slightly toward each other, very simple and minimal, only two shapes",
  },
  {
    file: "shots/kb5.jpg",
    motif:
      "an arch bridge with a small crescent moon above it, drawn with VERY THICK bold strokes, " +
      "completely hollow (outline only, not filled), very simple and minimal, only two shapes",
  },
  {
    file: "shots/kb6.jpg",
    motif:
      "a single winding vine curling into a spiral with two small leaves on it, " +
      "drawn with VERY THICK bold strokes, completely hollow (outline only, not filled), " +
      "very simple and minimal, only two or three shapes",
  },
];

const STYLE =
  "flat 2D vector icon, completely flat with no volume no shading no 3d no bevel no metallic, " +
  "single flat antique gold color, bold heavy uniform stroke weight, " +
  "the subject fills about 70 percent of the frame, centered, " +
  "flat solid deep purple background, " +
  "the shape floats alone in the exact center with completely empty deep purple space on all four sides, " +
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge, " +
  "there is absolutely nothing else in the picture besides the single shape, " +
  "no border, no outline box, no decorative corners, no ground shadow, no pedestal, no base plate, " +
  "no text, no letters, no people, no hands, " +
  "no thin lines, no fine details, no gradient, no texture, no glow";

for (const j of JOBS) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", `${j.motif}, ${STYLE}`, "shots/nt6.jpg", j.file, "1:1"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + j.file + " " + (e.stdout || "") + (e.stderr || "").slice(0, 100));
  }
}
