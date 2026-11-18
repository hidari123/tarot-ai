import { execFileSync } from "node:child_process";

/**
 * ⚠️ 批量生成"蓝紫 + 饱满"的星云（16:9）
 * ⚠️ 用户说「目前没有觉得好看的」→ 换一批 prompt 再抽
 */

/**
 * ⚠️ prompt 的调参经验（多轮抽卡）：
 * · "violet / purple / amethyst" → 太紫太艳 → 用 "deep indigo / slate blue / muted violet"
 * · "billowing / filling the frame" → 饱满 ✅
 * · "soft veils / drapery" → 纱幕感（像 nt6）✅
 * · "no galaxy core / no spiral" → 避免星系 ✅
 * · "dark and subtle / muted" → 压得住内容 ✅
 */
const PROMPTS = [
  {
    file: "shots/q1.jpg",
    p: "deep indigo and slate blue nebula with faint muted violet highlights, soft billowing gas clouds filling the entire frame edge to edge, wispy drapery shapes, deep navy space, tiny scattered stars, low saturation elegant dark astrophotography, no galaxy core, no spiral structure",
  },
  {
    file: "shots/q2.jpg",
    p: "a vast dark blue nebula field, smoky periwinkle and grey violet clouds layered thickly across the whole frame, soft glowing core area, scattered white pinprick stars, muted refined color grading, subtle and moody, absolutely no spiral galaxy",
  },
  {
    file: "shots/q3.jpg",
    p: "blue purple cosmic clouds like soft silk drapes, dusty lavender and midnight blue, luminous white-violet core glowing through the middle, dark starry space around, rich texture, elegant low-key lighting, no circular galaxy shape",
  },
  {
    file: "shots/q4.jpg",
    p: "an endless field of dark blue and violet nebula mist, gentle billows and torn cloud edges, subtle magenta hints in the folds, deep space backdrop, fine star dust, cinematic subdued palette, no bright central bulge, no spiral arms",
  },
  {
    file: "shots/q5.jpg",
    p: "twilight nebula in deep blue and violet, gauzy translucent veils filling the entire vertical frame, soft internal luminosity, scattered distant stars, smooth velvety texture, refined and calm, no spiral galaxy shape",
  },
  {
    file: "shots/q6.jpg",
    p: "ominous deep blue nebula clouds with cold purple highlights, thick rolling formations covering the whole image, dim glowing pockets, sparse stars, dark sophisticated space art, high detail, no elliptical galaxy, no core",
  },
];

for (const item of PROMPTS) {
  try {
    const out = execFileSync(
      "node",
      ["scripts/dev/gen-image-ref.mjs", item.p, "shots/nt6.jpg", item.file, "16:9"],
      { encoding: "utf-8" }
    );
    console.log(out.trim());
  } catch (e) {
    console.log("✗ " + (e.stdout || "") + (e.stderr || "").slice(0, 150));
  }
}
