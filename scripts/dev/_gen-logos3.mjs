import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 MOIRA 的 logo 概念（3 个变体 · AI 插画风 · 圆胖卡通）
 *
 * ⚠️ 用户的核心诉求：
 *   「标签页的那个logo 现在看不清楚」
 *   「月亮和星星都太细了 星星太小了」
 *   「设计的圆胖卡通一点 看得清楚」
 *   「星星月亮的意向可以的」
 *
 * ⚠️ AI 出图的关键（吸取前面的经验）：
 *   · 强调 **thick / chunky / bold / rounded / cartoon / cute**
 *   · 强调 **solid filled shapes**（不是 monoline —— monoline 就是"太细"的元凶）
 *   · 强调 **large star**（"星星太小"）
 *   · 强调 **no thin lines**
 *   · 背景要**纯色**（方便抠出 SVG）
 */

/**
 * 三个变体：
 *   1. 带底色（圆角紫底 + 金色胖月牙 + 大星星）
 *   2. 不带底（透明底，单独图形）
 *   3. 带文字（图形 + MOIRA 字样）
 */
const CONCEPTS = [
  {
    file: "shots/logo-v1.png",
    p: "app icon design, a chunky cute crescent moon with a big solid four-pointed star nestled in its curve, thick bold filled shapes, rounded cartoon style, kawaii but mystical, deep purple rounded-square background with soft gradient, golden yellow moon and star, flat vector illustration, very simple and chunky, high contrast, centered, no text, no letters, no thin lines, no outlines",
  },
  {
    file: "shots/logo-v2.png",
    p: "logo mark, a chunky fat crescent moon embracing one large solid five-pointed star, very thick rounded filled shapes, adorable cartoon mascot style, golden yellow on transparent plain background, flat vector illustration, extremely simple bold silhouette, no text, no letters, no thin lines, no outline strokes, centered composition",
  },
  {
    file: "shots/logo-v3.png",
    p: "logo lockup, on the left a chunky cute crescent moon with a big solid four-pointed star, and to the right the word MOIRA in elegant bold serif capital letters, thick rounded shapes, golden yellow elements, plain solid purple background, flat vector illustration, playful yet mystical brand mark, no thin lines, wide horizontal composition",
  },
];

for (const c of CONCEPTS) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", c.p, "shots/nt6.jpg", c.file, "1:1"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + (e.stdout || "") + (e.stderr || "").slice(0, 150));
  }
}
