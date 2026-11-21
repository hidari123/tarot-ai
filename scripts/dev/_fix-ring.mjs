import { readFileSync, writeFileSync } from "node:fs";

// ⚠️ OrbCategoryRing：改用**参数角**（椭圆等距分布 + 严格对称）
const P = "src/features/divination/components/OrbCategoryRing.tsx";
const lines = readFileSync(P, "utf-8").split(/\r?\n/);

// 找 const side = ... 那行
const i0 = lines.findIndex((l) => l.includes("const side = i < 4 ? -1 : 1;"));
if (i0 < 0) { console.log("MISS 锚点"); process.exit(1); }
// 往上找到 const deg 那行的上一行（注释块起点在更上面）→ 只替换 3 行代码
const i2 = lines.findIndex((l, i) => i > i0 && l.includes("const angle = deg * (Math.PI / 180);"));
if (i2 < 0) { console.log("MISS angle"); process.exit(1); }

lines.splice(
  i0,
  i2 - i0 + 1,
  "        /**",
  "         * ⚠️⚠️⚠️ 对称性（用户反馈：「小女孩眼睛和你的弧线不对称」）",
  "         *   · 之前用**几何角** + 椭圆半径（rx≠ry）→ 椭圆上的点按圆角度分布",
  "         *     → 上下半圈**角速度不均** → 视觉上左右不对称 ❌",
  "         *   → 这版用**参数角**（椭圆参数方程里的 t）：",
  "         *     x = cx + rx·cos(t)，y = cy + ry·sin(t)",
  "         *     · 参数角均匀 → 沿椭圆**等距分布** ✅",
  "         *     · 左右两段严格镜像 → **完全对称** ✅",
  "         * ⚠️ 中间留空（95°~85°）→ 正上方是标题和脸，不能压",
  "         */",
  "        const t =",
  "          (i < 4 ? 95 + (1 - i / 4) * 85 : 85 - ((i - 4) / 4) * 85) *",
  "          (Math.PI / 180);"
);

// 替换 style 里的 angle → t
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("Math.cos(angle)")) lines[i] = lines[i].replace("Math.cos(angle)", "Math.cos(t)");
  if (lines[i].includes("Math.sin(angle)")) lines[i] = lines[i].replace("Math.sin(angle)", "Math.sin(t)");
}

writeFileSync(P, lines.join("\r\n"), "utf-8");
console.log("✓ 已改为参数角");
