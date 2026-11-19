import { execFileSync } from "node:child_process";

/**
 * ⚠️ 补 2 张（实心剪影在亮度抠图下会碎）
 *   · 晨星：线条太阳 + 星
 *   · 备用：晨星
 */
const JOBS = [
  {
    file: "shots/f1-morning.jpg",
    motif:
      "a bold sun made of a thick outlined circle with twelve straight rays around it, " +
      "one small four-pointed star at the upper right, drawn with VERY THICK strokes, " +
      "completely hollow in the middle (outline only, not filled)",
  },
  {
    file: "shots/f1-morning2.jpg",
    motif:
      "a simple thick outlined sun circle with eight short rays, one small solid four-pointed star beside it, " +
      "drawn with VERY THICK strokes, completely hollow in the middle (outline only, not filled)",
  },
];

const STYLE =
  "flat 2D vector icon, completely flat with no volume no shading no 3d, " +
  "single flat antique gold color, only two or three big rounded shapes, " +
  "flat solid deep purple background, " +
  "the shape floats alone in the exact center with completely empty deep purple space on all four sides, " +
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge, " +
  "there is absolutely nothing else in the picture besides the single shape, " +
  "no border, no outline box, no decorative corners, no filled solid shapes, " +
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
