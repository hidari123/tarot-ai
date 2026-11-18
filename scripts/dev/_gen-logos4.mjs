import { execFileSync } from "node:child_process";

/**
 * ⚠️ logo 重出（第 2 轮）
 *
 * ⚠️⚠️ 第 1 轮的两个问题：
 *   1. **月亮/星星带表情**（眼睛、腮红、笑脸）→ 太"吉祥物"，没有占卜的**神秘感**
 *      → 负向词加：no face, no eyes, no smile, no blush, no cute mascot face
 *   2. **带文字的版本翻车** —— AI 把 "MOIRA" 画成了"思维过程图"
 *      → 文字版**不指望 AI** → 图形用 AI 出，文字用 **HTML/SVG 排**
 *      → 但为了让图形能和文字并排，需要图形在**左侧留白**（icon-only）
 */

/**
 * 三个变体：
 *   v1. 带底色（圆角紫底 + 金色胖月牙 + 大星星）
 *   v2. 不带底（透明/纯色底，单独图形，右侧留白便于并排文字）
 *   v3. 带底色 + 更简洁（去掉装饰小点，只要月牙和星星）
 */
const CONCEPTS = [
  {
    file: "shots/logo2-a.png",
    p: "app icon, a chunky solid crescent moon with a large solid four-pointed star resting in its curve, smooth rounded geometric shapes, golden yellow flat colors on deep purple rounded square tile, mystical minimalist emblem, symmetrical balanced composition, thick solid shapes, clean and bold, no face, no eyes, no smile, no blush, no mascot, no tiny decorative dots, no text, no letters, no thin lines, no outlines, no gradient noise",
  },
  {
    file: "shots/logo2-b.png",
    p: "standalone icon mark, a plump solid crescent moon cradling one big solid four-pointed star, pure flat golden yellow shape on plain solid deep purple background, chunky rounded geometric forms, bold iconic silhouette, mystical and calm, icon positioned in the LEFT HALF of the frame with empty space on the right, no face, no eyes, no expression, no mascot, no text, no letters, no thin lines, no outline, no sparkles, no small dots",
  },
  {
    file: "shots/logo2-c.png",
    p: "app icon, simple chunky crescent moon and one large solid five-pointed star side by side, both filled flat golden yellow, on a deep purple rounded square tile with soft inner glow, extremely simple bold shapes, modern minimal mystical emblem, balanced composition, no face, no eyes, no smile, no mascot, no extra decorations, no text, no letters, no thin lines, no outlines",
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
