import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张分类图标 —— 第 2 轮（金色细线 · 纯黑底）
 *
 * ⚠️⚠️ 第 1 轮的问题（实测 24 张）：
 *   1. **背景不是透明的** —— prompt 说 "transparent background" AI 不听
 *      → 改成 **solid pure black background**（和我们要的深色底一致）
 *      → 抠图变成简单的阈值化 → 100% 干净 ✅
 *   2. **主体大小不一致** —— 有的占满、有的缩在角落
 *      → prompt 加 "fills 70% of the frame, centered, generous margin"
 *      + 后处理统一 trim + 缩放 ✅
 *   3. **语义偏差** —— "两条分叉的箭头" 变成算命招牌
 *      → 意象描述改成**几何图形**（不是场景），更不容易被误解 ✅
 *   4. **个别图带装饰边框** → 负向词加 "no enclosing shape, no frame around it"
 *
 * ⚠️ 风格基准 = 现有的 icon-daily.webp
 *   单色金色细线 / 透明底 / 极简符号 / 圆融造型 / 无边框 / 无阴影
 */

/** 8 个分类 → 几何化的意象描述（避免 AI 自由发挥） */
const TYPES = [
  { id: "love", zh: "月引", motif: "two heart outlines overlapping, with one thin spiral ribbon looping around both" },
  { id: "career", zh: "远途", motif: "a triangular mountain outline with one zigzag line climbing up its face and a tiny four-pointed star at the peak" },
  { id: "wealth", zh: "丰盈", motif: "a balance scale outline, one vertical post one horizontal beam two hanging pans, small circles resting in the pans" },
  { id: "crossroads", zh: "歧路", motif: "one vertical line at the bottom splitting into two lines that diverge diagonally upward to the left and to the right, each ending in a small arrowhead" },
  { id: "tides", zh: "潮汐", motif: "three parallel horizontal wavy lines of decreasing length stacked on top of each other, with one small crescent shape above them" },
  { id: "morning", zh: "晨星", motif: "a plain circle in the middle with twelve straight rays radiating outward from it, and one small four-pointed star at the upper right" },
  { id: "kindred", zh: "故人", motif: "two simple hand outlines reaching toward each other from the left and right, fingertips nearly touching in the middle" },
  { id: "whispers", zh: "幽微", motif: "an almond shaped eye outline with a small four-pointed star at its center instead of a pupil" },
];

/**
 * 三套变体（同一意象，不同画法）
 */
const VARIANTS = [
  {
    tag: "a",
    desc: "单线描边（最接近 icon-daily）",
    style:
      "single thin gold line art icon, one clean continuous outline drawing, " +
      "even uniform line weight, flat solid antique gold color, " +
      "solid pure black background, fills about 70 percent of the frame, centered, generous even margin",
  },
  {
    tag: "b",
    desc: "线略粗 + 少量内部细节线",
    style:
      "gold line art icon drawn with confident medium weight strokes plus a few sparse internal detail lines, " +
      "flat solid antique gold color, solid pure black background, " +
      "fills about 70 percent of the frame, centered, generous even margin",
  },
  {
    tag: "c",
    desc: "严格几何（圆弧直线构成）",
    style:
      "strictly geometric gold line art icon constructed only from circles arcs and straight lines, " +
      "symmetrical abstract construction, flat solid antique gold color, solid pure black background, " +
      "fills about 70 percent of the frame, centered, generous even margin",
  },
];

const NEG =
  "no fill, no solid filled shapes, no 3d, no shading, no realistic rendering, no engraving, no relief, " +
  "no enclosing shape, no frame around it, no rectangular tile, no square outline, no circle frame, " +
  "no decorative corners, no ornate border, no drop shadow, no glow, no vignette, " +
  "no cute, no cartoon, no mascot, no character, no face, no eyes with pupils, no animals, no people, " +
  "no text, no letters, no numbers, no signboard, no banner, no scroll, no watermark";

const JOBS = [];
for (const v of VARIANTS) {
  for (const t of TYPES) {
    JOBS.push({
      file: `shots/l2-${v.tag}-${t.id}.jpg`,
      prompt: `${t.motif}, ${v.style}, ${NEG}`,
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
