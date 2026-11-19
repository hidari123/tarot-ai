import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张分类图标 —— 第 5 轮（v3 意象 · 扁平化 · 多组）
 *
 * ⚠️⚠️ 用户反馈（原文）：
 *   「这些可以 但是最好v3生成的也可以再扁平一点」
 *   「你还是生成8张吧 我只是说这些图标可以的 多生成几组」
 *
 * ⚠️ 关键理解：
 *   · v3（粗线稿）那 8 张的**意象和构图都被认可** ✅
 *   · 唯一要改的是「**更扁平**」→ 线条更细、更平面、不那么厚重
 *   · 要**多生成几组** → 每组 8 张，用同样的 8 个意象
 *
 * ⚠️ 「扁平」在 prompt 里的表达：
 *   flat / 2D vector / no volume / no thickness variation / uniform stroke
 *   thin elegant line / flat single color / no gradient on the shape
 *
 * ⚠️ 同时保留「无边框」的要求（v3 那些没有框 ✅）
 */

/** 沿用 v3 的 8 个意象（已确认） */
const TYPES = [
  { id: "love", zh: "月引", motif: "two elegant hearts intertwined with a thin spiralling ribbon" },
  { id: "career", zh: "远途", motif: "a mountain outline with a winding path and a small four-pointed star at the peak" },
  { id: "wealth", zh: "丰盈", motif: "a balance scale with round coins resting in the pans" },
  { id: "crossroads", zh: "歧路", motif: "one path splitting into two diverging arrow branches" },
  { id: "tides", zh: "潮汐", motif: "layered curling ocean waves beneath a crescent moon" },
  { id: "morning", zh: "晨星", motif: "a sun disc with radiating rays beside a small four-pointed star" },
  { id: "kindred", zh: "故人", motif: "two open hands reaching toward each other, fingertips touching" },
  { id: "whispers", zh: "幽微", motif: "an eye shape with a small four-pointed star at its center" },
];

/**
 * 四组变体（都是「扁平」，只是扁平的方式不同）
 */
const VARIANTS = [
  {
    tag: "p",
    desc: "扁平细线（2D vector，最平）",
    style:
      "flat 2D vector icon, thin uniform stroke weight, completely flat with no volume no thickness no shading, " +
      "single flat antique gold color, purely two dimensional graphic, " +
      "flat solid deep purple background, the shape floats alone in the center with empty space on all sides",
  },
  {
    tag: "q",
    desc: "扁平 + 细描边填充",
    style:
      "flat 2D vector icon with very thin outlines and completely flat fills, no gradients no shading no bevel, " +
      "flat antique gold and pale cream, purely two dimensional, " +
      "flat solid deep purple background, the shape floats alone in the center with empty space on all sides",
  },
  {
    tag: "r",
    desc: "扁平几何（极简线条）",
    style:
      "minimal flat geometric line icon, thin elegant strokes, abstract and clean, purely two dimensional flat graphic, " +
      "flat antique gold, " +
      "flat solid deep purple background, the shape floats alone in the center with empty space on all sides",
  },
  {
    tag: "s",
    desc: "扁平 + 轻描边（介于 v3 和纯平之间）",
    style:
      "slightly thicker flat outline icon, clean 2D vector art with gentle stroke but still clearly flat and not volumetric, " +
      "flat antique gold, " +
      "flat solid deep purple background, the shape floats alone in the center with empty space on all sides",
  },
];

const NO_FRAME = [
  "the shape floats alone in the exact center with completely empty deep purple space on all four sides",
  "the shape is NOT inside a frame, NOT inside a rectangle, NOT inside a square, NOT inside a circle, NOT inside a badge",
  "there is absolutely nothing else in the picture besides the single shape",
  "no border, no outline box, no enclosing frame, no decorative corners, no edge line",
].join(", ");

const NEG =
  "no text, no letters, no numbers, no writing, no signboard, no banner, no scroll, " +
  "no ui panel, no screenshot, no watermark, no signature, " +
  "no 3d, no volume, no thickness, no shadow, no glow, no metallic shine, no bevel, " +
  "no gradient background, no texture, no vignette";

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
