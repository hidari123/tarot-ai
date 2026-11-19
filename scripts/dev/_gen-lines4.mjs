import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张分类图标 —— 第 4 轮（超粗 + 超简单 + 无边框）
 *
 * ⚠️⚠️ 用户反馈（原文）：
 *   「让ai不要加边框 生成的线条粗一点 不要太复杂的线条 简洁明了」
 *   （先说成"对话框"，后更正为"边框"）
 *
 * ⚠️ 前三轮的失败：
 *   第 1 轮：细线单描边 → 线条太细
 *   第 2 轮：纯黑底 → 抠图崩了
 *   第 3 轮：d/e/f 三套 → 线条仍偏细 + AI 加了矩形画框 + 细节太碎
 *
 * ⚠️⚠️ 这一轮 prompt 的关键改动（针对"AI 不听 no frame"）：
 *   1. **正面描述**："the shape floats alone in the middle of the canvas with empty space on all sides"
 *   2. **反面描述**："no border around the shape, the shape is NOT inside a frame, NOT inside a square, NOT inside a circle"
 *   3. **粗线条**："drawn with an extremely thick bold marker, as if painted with a 20mm brush"
 *   4. **简单**："only 2 or 3 big rounded shapes, nothing more"
 */

/** 极简意象（每张 ≤3 个元素） */
const TYPES = [
  { id: "love", zh: "月引", motif: "two chunky hearts side by side" },
  { id: "career", zh: "远途", motif: "a chunky mountain triangle with a small star above it" },
  { id: "wealth", zh: "丰盈", motif: "a chunky balance scale" },
  { id: "crossroads", zh: "歧路", motif: "two chunky arrows pointing diagonally up-left and up-right" },
  { id: "tides", zh: "潮汐", motif: "two thick wave strokes" },
  { id: "morning", zh: "晨星", motif: "a thick circle sun with eight short rays" },
  { id: "kindred", zh: "故人", motif: "two chunky hands touching fingertips" },
  { id: "whispers", zh: "幽微", motif: "a thick eye outline with one solid star inside" },
];

const STYLE = [
  {
    tag: "g",
    desc: "超粗马克笔",
    style:
      "icon drawn with an EXTREMELY THICK bold golden yellow marker, as if painted with a 20mm brush, " +
      "very heavy rounded stroke weight, extremely simple and minimal, only two or three big rounded shapes and nothing else, " +
      "flat solid deep purple background",
  },
  {
    tag: "h",
    desc: "实心块面（无描边）",
    style:
      "solid filled chunky shapes with NO outline strokes at all, simple rounded silhouettes, " +
      "extremely minimal, only two or three big shapes, " +
      "flat solid deep purple background",
  },
  {
    tag: "i",
    desc: "粗线 + 平涂",
    style:
      "icon with EXTREMELY THICK bold golden yellow strokes plus a few solid flat filled accents, " +
      "extremely simple and minimal, only two or three big shapes, " +
      "flat solid deep purple background",
  },
];

/**
 * ⚠️⚠️ 边框的禁止 —— 正面 + 反面双重表述
 */
const NO_FRAME = [
  "the shape floats alone in the exact center of the canvas with completely empty deep purple space on all four sides",
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge",
  "there is absolutely nothing else in the picture besides the single shape",
  "no border, no outline box, no enclosing frame, no decorative corners, no margin line, no edge line",
  "the picture edges are plain empty purple, completely blank",
].join(", ");

const NEG =
  "no text, no letters, no numbers, no writing, no signboard, no banner, no scroll, no document, " +
  "no ui panel, no screenshot, no watermark, no signature, no logo box, " +
  "no thin lines, no fine details, no small elements, no complex ornament, no lace, " +
  "no gradient background, no texture, no shadow, no glow, no vignette";

const JOBS = [];
for (const v of STYLE) {
  for (const t of TYPES) {
    JOBS.push({
      file: `shots/v4-${v.tag}-${t.id}.jpg`,
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
