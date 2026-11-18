import { execFileSync } from "node:child_process";

/**
 * ⚠️ logo 第 3 轮 —— 解决「月牙和星星融合」
 *
 * ⚠️⚠️ 上一版的问题：
 *   描摹时月牙和大星星是**一个连通域**（在原图里搭在一起）
 *   → 二值化后连成一片 → 描摹成一个轮廓 → 内部分界线丢失
 *   → 星星"融进"月牙，看起来像月牙上长了个角 ❌
 *
 * ⚠️ 解法：让 AI 把它们**画开**（不接触）→ 描摹时是两个独立连通域
 *   → 可以自由调整大小/位置 → 也能分别换色
 */

const CONCEPTS = [
  {
    file: "shots/logo3-a.png",
    p: "app icon, one plump solid golden crescent moon on the left and one large solid golden four-pointed star floating separately on the upper right, the moon and star clearly separated with a gap between them, not touching, not overlapping, thick rounded solid shapes, deep purple rounded square tile background, flat vector illustration, mystical minimal emblem, no face, no eyes, no smile, no blush, no mascot, no cute, no text, no letters, no thin lines, no outlines, no sparkles, no small dots",
  },
  {
    file: "shots/logo3-b.png",
    p: "app icon, a big chunky golden five-pointed star with rounded points sitting in the curve of a separate plump golden crescent moon, clear white space gap separating the star from the moon so both shapes read individually, very thick solid filled shapes, deep purple rounded square tile, flat vector, mystical symbol, bold and simple, no face, no eyes, no expression, no cute, no cartoon, no mascot, no text, no letters, no thin lines, no outline",
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
    console.log("✗ " + (e.stdout || "") + (e.stderr || "").slice(0, 120));
  }
}
