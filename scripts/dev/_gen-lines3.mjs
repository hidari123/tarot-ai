import { execFileSync } from "node:child_process";

/**
 * ⚠️ 生成 8 张分类图标 —— 第 3 轮（三个新方向）
 *
 * ⚠️⚠️ 前两轮的失败总结：
 *   第 1 轮（细线单色）：4/8 可用，但背景不透明、主体大小不一
 *   第 2 轮（纯黑底）：抠图算法崩了 → 满屏噪点 + 文字残留
 *   → 共同问题：**一次生成 8 张，质量不可控**
 *   → 这轮：每个分类**单独生成**，prompt 更精确
 *
 * ⚠️ 三个方向（用户要求）：
 *   A. **线条粗一点** —— 保留线稿风格但加粗
 *   B. **偏卡通写实** —— 有体积感的 3D/立体插画
 *   C. **tarotoo 风格** —— 小图标、扁平、彩色点缀
 *
 * ⚠️ 背景处理：
 *   → 统一用 **solid deep purple background**（和页面底色一致）
 *   → 抠图时用「亮度差」而不是饱和度（深紫底的暗部细节不会误判）
 */

/** 8 个分类 → 精确的意象描述 */
const TYPES = [
  { id: "love", zh: "月引", motif: "two intertwined hearts with a spiralling ribbon" },
  { id: "career", zh: "远途", motif: "a mountain peak with a winding path and a star above" },
  { id: "wealth", zh: "丰盈", motif: "a balance scale holding coins" },
  { id: "crossroads", zh: "歧路", motif: "a path splitting into two diverging arrow branches" },
  { id: "tides", zh: "潮汐", motif: "layered curling ocean waves beneath a crescent moon" },
  { id: "morning", zh: "晨星", motif: "a sun disc with radiating rays beside a small star" },
  { id: "kindred", zh: "故人", motif: "two hands reaching toward each other" },
  { id: "whispers", zh: "幽微", motif: "an eye shape with a small star at its center" },
];

/**
 * 三种风格
 */
const VARIANTS = [
  {
    tag: "d",
    desc: "粗线稿（细线的加粗版）",
    style:
      "thick bold gold line art icon, heavy confident stroke weight like a marker pen, " +
      "flat solid antique gold strokes on a solid deep purple background, " +
      "simple bold shapes, fills 70 percent of the frame, centered",
  },
  {
    tag: "e",
    desc: "卡通写实（立体插画）",
    style:
      "small 3d rendered cartoon icon, rounded chunky shapes with soft shading and subtle highlights, " +
      "warm gold and cream materials on a solid deep purple background, " +
      "playful but tasteful collectible mascot style, centered, fills 70 percent of the frame",
  },
  {
    tag: "f",
    desc: "tarotoo 风（扁平小图标）",
    style:
      "tiny flat app icon, simple flat colored shapes with minimal detail, " +
      "violet and gold and cream color palette, solid deep purple background, " +
      "modern mobile app icon design, very simple and iconic, centered, fills 65 percent of the frame",
  },
];

const NEG =
  "no text, no letters, no numbers, no writing, no signboard, no banner, no scroll, no document, " +
  "no interface screenshot, no ui panel, no watermark, " +
  "no frame, no enclosing square outline, no border, no decorative corners";

const JOBS = [];
for (const v of VARIANTS) {
  for (const t of TYPES) {
    JOBS.push({
      file: `shots/v3-${v.tag}-${t.id}.jpg`,
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
