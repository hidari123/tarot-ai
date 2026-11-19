import { execFileSync } from "node:child_process";

/**
 * ⚠️ 补齐剩余分类的图标 —— 只做「粗线条 + 极简 + 无边框」
 *
 * ⚠️ 已定稿（用户确认）：
 *   ① 月引   → v3 爱心
 *   ③ 丰盈   → 第一轮天平
 *   ⑤ 潮汐   → 第一轮海浪
 *   ⑥ 晨星   → 第一轮太阳
 *   ⑧ 幽微   → v3 眼睛
 *   ② 远途 / ④ 歧路 / ⑦ 故人 → 重新生成（这几张第一/三轮都不理想）
 *
 * ⚠️ prompt 的三个重点（用户反馈）：
 *   1. 线条**再粗一点**
 *   2. **不要太复杂**（2~3 个形状）
 *   3. **不要边框**
 */

const TYPES = [
  { id: "career", zh: "远途", motif: "a solid chunky mountain triangle with one small solid star floating above its peak" },
  { id: "crossroads", zh: "歧路", motif: "two solid chunky arrows, one pointing up-left and one pointing up-right, meeting at a single point at the bottom" },
  { id: "kindred", zh: "故人", motif: "two solid chunky open hands reaching toward each other, fingertips about to touch" },
  { id: "tides", zh: "潮汐", motif: "two thick solid wave curves stacked" },
];

const VARIANTS = [
  {
    tag: "k",
    desc: "超粗描边",
    style:
      "single icon drawn with an EXTREMELY THICK bold golden yellow marker, as if painted with a fat 20mm brush, " +
      "very heavy rounded stroke weight, extremely simple and minimal, only two or three big rounded shapes and nothing more, " +
      "flat solid deep purple background",
  },
  {
    tag: "m",
    desc: "实心块面",
    style:
      "solid filled chunky shapes with NO outline strokes at all, simple rounded silhouettes, " +
      "extremely minimal, only two or three big shapes, " +
      "flat solid deep purple background",
  },
];

/**
 * ⚠️ 边框禁止：正面 + 反面双重表述（AI 对「no frame」不敏感，但对「floating alone with empty space」敏感）
 */
const NO_FRAME = [
  "the shape floats alone in the exact center of the canvas with completely empty deep purple space on all four sides",
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge or emblem",
  "there is absolutely nothing else in the picture besides the single shape",
  "no border, no outline box, no enclosing frame, no decorative corners, no edge line, no margin line",
  "the picture edges are plain empty purple, completely blank",
].join(", ");

const NEG =
  "no text, no letters, no numbers, no writing, no signboard, no banner, no scroll, no document, " +
  "no ui panel, no screenshot, no watermark, no signature, " +
  "no thin lines, no fine details, no small elements, no complex ornament, no lace, no filigree, " +
  "no gradient background, no texture, no shadow, no glow, no vignette";

const JOBS = [];
for (const v of VARIANTS) {
  for (const t of TYPES) {
    JOBS.push({
      file: `shots/v5-${v.tag}-${t.id}.jpg`,
      prompt: `${t.motif}, ${v.style}, ${NO_FRAME}, ${NEG}`,
    });
  }
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
