import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张分类图标 —— 第 6 轮（**粗线条 + 扁平**）
 *
 * ⚠️⚠️ 用户反馈（原文）：
 *   「线条粗一点 扁平一点」
 *   ⚠️ 第 5 轮方向错了：我做成了「**细**线扁平」→ 用户要的是「**粗**线扁平」
 *
 * ⚠️ 「粗 + 扁平」在 prompt 里的正确表达：
 *   · 粗：thick bold stroke / heavy line weight / wide marker
 *   · 扁平：flat 2D / no volume / no shading / no gradient on the shape / pure two dimensional
 *   ⚠️ 这两件事**不矛盾**：粗线条可以完全是平面的（没有体积感）
 *   → 关键负向词：**no 3d, no volume, no thickness variation, no shading, no bevel, no metallic**
 *
 * ⚠️ 意象沿用 v3（已确认）
 */

const TYPES = [
  { id: "love", zh: "月引", motif: "two bold hearts intertwined with a spiralling ribbon" },
  { id: "career", zh: "远途", motif: "a bold mountain outline with a winding path and a small four-pointed star at the peak" },
  { id: "wealth", zh: "丰盈", motif: "a bold balance scale with round coins resting in the pans" },
  { id: "crossroads", zh: "歧路", motif: "one bold path splitting into two diverging arrow branches" },
  { id: "tides", zh: "潮汐", motif: "bold layered curling ocean waves beneath a crescent moon" },
  { id: "morning", zh: "晨星", motif: "a bold sun disc with radiating rays beside a small four-pointed star" },
  { id: "kindred", zh: "故人", motif: "two bold open hands reaching toward each other, fingertips touching" },
  { id: "whispers", zh: "幽微", motif: "a bold eye shape with a small four-pointed star at its center" },
];

/**
 * 四组变体（都粗，都扁平，区别在填充/配色）
 */
const VARIANTS = [
  {
    tag: "t",
    desc: "粗描边 · 纯平面单色",
    style:
      "icon with VERY THICK bold strokes, heavy wide line weight, drawn as a completely flat 2D vector graphic, " +
      "no volume no shading no bevel no metallic shine, purely two dimensional, " +
      "single flat antique gold color, flat solid deep purple background",
  },
  {
    tag: "u",
    desc: "粗描边 + 扁平填色",
    style:
      "icon with VERY THICK bold strokes plus completely flat solid filled areas, entirely flat 2D vector art, " +
      "no gradient no shading no 3d no volume, " +
      "flat antique gold and pale cream, flat solid deep purple background",
  },
  {
    tag: "v",
    desc: "粗线条 · 扁平几何",
    style:
      "bold heavy-stroke geometric line icon, thick confident uniform line weight, " +
      "entirely flat two dimensional vector, no depth no shading no 3d, " +
      "flat antique gold, flat solid deep purple background",
  },
  {
    tag: "w",
    desc: "粗线条 · 扁平单色剪影",
    style:
      "bold thick-stroke silhouette icon, heavy rounded line weight, " +
      "flat monochrome two dimensional graphic with absolutely no depth or volume, " +
      "flat antique gold, flat solid deep purple background",
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
  "no 3d, no volume, no depth, no perspective, no shading, no highlight, no bevel, no emboss, " +
  "no metallic, no chrome, no glossy, no realistic rendering, no engraving, " +
  "no gradient background, no texture, no vignette, no drop shadow, no glow";

const JOBS = [];
for (const v of VARIANTS) {
  for (const t of TYPES) {
    JOBS.push({
      file: `shots/v6-${v.tag}-${t.id}.jpg`,
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
