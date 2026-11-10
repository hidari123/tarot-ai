#!/usr/bin/env node
/**
 * 「开始占卜」按钮 —— AI 出图方案 v3（2026-11-09 第二轮）
 *
 * ⚠️ v2（y1~y6）的问题诊断：
 *   ① **中间被画成羊皮纸/画布底**（4/6 张）→ 底太亮 → 文字压不住
 *      根因：prompt 里写了 "EMPTY CENTER"，
 *            模型理解成"一块空白画布"，而不是"深色的空"
 *      → 修正：明确写 **"the center must be DARK EMPTY SPACE, deep navy black,
 *        absolutely no parchment, no paper, no canvas, no beige"**
 *   ② **比例是 2:1 不是 3:1**（模型按 16:9 画）
 *      → 修正：prompt 里写 "extremely wide 4 to 1 banner"（要求更宽）
 *        + 后期**居中裁切**到 3:1
 *   ③ 边框形态偏厚重（y4）
 *      → 修正：加 "delicate thin lines, airy, lots of negative space"
 *
 * ⚠️ 保留的配色方向（用户认可的）：
 *   · y3 青玉符纹（jade green + gold）
 *   · y5 深蓝星图（midnight blue + gold stars）
 *   · 再扩展 2 个：月白星芒（但要求深底）、琥珀藤蔓（深底）
 *
 * 用法：node scripts/dev/gen-btn-variants.mjs
 */

import { spawnSync } from "node:child_process";

const VARIANTS = [
  {
    id: "z1",
    name: "青玉符纹（深底版）",
    desc: "青绿符咒线条 + 金色角饰，中间深黑",
    palette: "muted jade green #6fbfa0 and soft teal #4a9c8c, with small antique gold #c9a24a corner ornaments",
    form: "small rune-like geometric symbols and short dashes arranged sparsely along the border, large areas of empty space between them",
    extra: "cool mystical grimoire",
  },
  {
    id: "z2",
    name: "深蓝星图（深底版）",
    desc: "深蓝夜空 + 淡金星点连线，中间深蓝",
    palette: "deep midnight blue #3a5f96 with pale yellow #f0dfa0 star dots and faint cyan haze",
    form: "tiny scattered star dots connected by very thin faint lines like a constellation chart, very sparse",
    extra: "dreamy night sky almanac",
  },
  {
    id: "z3",
    name: "琥珀星屑（深底版）",
    desc: "暖琥珀小星点 + 细金线，中间深黑",
    palette: "warm amber #f0b840 and soft honey gold #d9a441, with a few tiny cream star sparkles",
    form: "a scattering of small four pointed stars and fine gold hairline dashes along the border",
    extra: "cozy mystical night",
  },
  {
    id: "z4",
    name: "月白光环（深底版）",
    desc: "淡黄细线 + 四角月牙，中间深黑",
    palette: "pale moon-yellow #f2e3a6 and soft ivory, very light and delicate",
    form: "a single thin line border with small crescent moon shapes at the four corners and tiny dots between them",
    extra: "quiet celestial ritual",
  },
];

/**
 * ⚠️ 关键：中心必须是"深色空白"的硬约束
 * ⚠️ 加上"极其宽"的 4:1 要求（后期再裁到 3:1）
 */
const buildPrompt = (v) =>
  `an extremely wide horizontal banner border, 4 to 1 aspect ratio, ` +
  `decorative frame drawn only around the outer edge, ` +
  `${v.form}, ` +
  `border colors: ${v.palette}, ` +
  `the CENTER of the banner is completely DARK EMPTY SPACE ` +
  `like deep night sky or black velvet, ` +
  `ABSOLUTELY NO parchment, NO paper, NO canvas, NO beige, NO tan, NO white paper in the center, ` +
  `delicate thin lines, airy, generous negative space, ` +
  `${v.extra}, ` +
  `soft painterly storybook illustration, gently stylized, ` +
  `NOT metallic, NOT gold foil, NOT embossed metal, NOT chrome, NOT shiny, ` +
  `matte painted texture, soft diffused glow, dark mysterious fantasy mood, ` +
  `flat front view, isolated on pure black background, ` +
  `no text, no letters, no words, centered`;

const OUT = "shots/gen";
console.log(`生成 ${VARIANTS.length} 个按钮方案 v3（深色中心 · 4:1）\n`);

for (const v of VARIANTS) {
  console.log(`── ${v.id} ${v.name}：${v.desc}`);
  const r = spawnSync(
    process.execPath,
    ["scripts/dev/gen-image.mjs", buildPrompt(v), `${OUT}/btn_${v.id}.jpg`, "16:9"],
    { stdio: "pipe", encoding: "utf-8" }
  );
  const out = (r.stdout || "") + (r.stderr || "");
  console.log("   " + out.trim().split("\n").slice(-1)[0]);
}
