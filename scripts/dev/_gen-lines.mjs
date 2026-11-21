import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张分类图标 —— 3 种「金色细线」风格
 *
 * ⚠️⚠️ 风格基准 = 现有的 icon-daily.webp
 *   特征：单色金色 / 细线条 / 透明底 / 极简符号 / 圆融造型 / 无边框 / 无阴影
 *   （月牙+书 / 罗盘星芒 / 眼+日芒）
 *
 * ⚠️⚠️ 前面几轮的失败教训（必须避免）：
 *   1. "adorable / cute / kawaii / mascot" → 变成萌系小怪物 ❌
 *   2. "flat vector, filled shapes, thick" → 变成写实雕刻 ❌
 *   3. "arcane emblem / sacred geometry / engraved" → 变成带画框的浮雕 ❌
 *   4. 没说清"细线单色" → AI 自由发挥
 *
 * ⚠️ 关键：负向词 + 正向词都要极其明确
 *   正向：single thin gold line drawing, line art, outline style, elegant minimal linework,
 *         flat solid gold color on transparent background, smooth rounded curves
 *   负向：no fill, no solid filled shapes, no 3d, no realistic, no engraving, no frame,
 *         no border, no decorative corners, no background tile, no rectangle, no circle frame,
 *         no cute, no cartoon, no mascot, no character, no face, no animals, no text
 */

/** 8 个分类的意象（用"符号"而不是"场景"，和 icon-daily 的书/眼同层级）*/
const TYPES = [
  { id: "love", zh: "月引", motif: "two heart outlines joined by a spiral ribbon" },
  { id: "career", zh: "远途", motif: "a mountain peak with a winding path and a small star above it" },
  { id: "wealth", zh: "丰盈", motif: "a balance scale with round coins" },
  { id: "crossroads", zh: "歧路", motif: "two diverging arrows splitting from one path" },
  { id: "tides", zh: "潮汐", motif: "three stacked curling wave lines with a small crescent" },
  { id: "morning", zh: "晨星", motif: "a sun disc with radiating straight rays and a small four-pointed star" },
  { id: "kindred", zh: "故人", motif: "two hands reaching toward each other with fingertips touching" },
  { id: "whispers", zh: "幽微", motif: "an almond eye outline with a small four-pointed star inside" },
];

/**
 * 三套变体（在同一基准上做细微差异，让用户挑）
 */
const VARIANTS = [
  {
    tag: "a",
    desc: "细线单描边（最接近 icon-daily）",
    style:
      "single continuous thin gold line art icon, elegant outline drawing, one unbroken contour, " +
      "flat solid antique gold color, transparent background, smooth graceful curves, " +
      "very minimal and refined, centered with generous margins",
  },
  {
    tag: "b",
    desc: "线条略粗一点 + 有一点结构层次",
    style:
      "bold thin gold line art icon, clean outline drawing with a few internal detail lines, " +
      "flat solid gold color, transparent background, balanced geometric composition, " +
      "refined and calm, centered with generous margins",
  },
  {
    tag: "c",
    desc: "几何化（把意象拆成纯几何符号）",
    style:
      "geometric gold line art icon built from simple circles, arcs and straight lines only, " +
      "pure abstract symmetric construction, flat solid gold color, transparent background, " +
      "precise and minimal like an astronomical instrument, centered with generous margins",
  },
];

const NEG =
  "no fill, no solid filled shapes, no 3d, no shading, no realistic rendering, no engraving, " +
  "no ornate frame, no border, no decorative corners, no rectangular tile, no square background, " +
  "no circle frame around the icon, no drop shadow, no glow, " +
  "no cute, no cartoon, no mascot, no character, no face, no eyes with pupils drawn, no animals, " +
  "no text, no letters, no numbers, no watermark";

const JOBS = [];
for (const v of VARIANTS) {
  for (const t of TYPES) {
    JOBS.push({
      file: `shots/line-${v.tag}-${t.id}.jpg`,
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
