import { execFileSync } from "node:child_process";

/**
 * ⚠️ 补 2 张（歧路 / 晨星）—— 必须是**纯线条**（hollow）
 * ⚠️ 实心剪影在局部自适应抠图下仍会碎（内部暗区被当背景）
 */

const JOBS = [
  {
    file: "shots/f2-crossroads.jpg",
    motif:
      "two thick outlined arrows pointing diagonally up-left and up-right, meeting at a single point at the bottom, " +
      "completely hollow outlines (not filled), very simple, only two shapes",
  },
  {
    file: "shots/f2-morning.jpg",
    motif:
      "a thick outlined sun circle with twelve straight rays around it, one small solid four-pointed star at the upper right, " +
      "completely hollow circle (not filled), very simple, only two shapes",
  },
];

const STYLE =
  "flat 2D vector icon, completely flat with no volume no shading no 3d, " +
  "single flat antique gold color on flat solid deep purple background, " +
  "only two or three big rounded shapes, bold uniform stroke weight, " +
  "the shape floats alone in the exact center with completely empty deep purple space on all four sides, " +
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge, " +
  "there is absolutely nothing else in the picture besides the single shape, " +
  "no border, no outline box, no decorative corners, no solid filled big shapes, " +
  "no text, no letters, no thin lines, no fine details, no gradient, no shadow, no glow";

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
