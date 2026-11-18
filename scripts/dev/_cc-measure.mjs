import sharp from "sharp";

/**
 * ⚠️ 量化：小女孩 vs 背景的亮度对比
 */
const img = sharp("shots/_cc.png");
const { width, height } = await img.metadata();
console.log(`截图 ${width}×${height}`);

/** 采样一个区域的平均亮度 */
async function lum(x, y, w, h, label) {
  const { data, info } = await sharp("shots/_cc.png")
    .extract({ left: x, top: y, width: w, height: h })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    r += data[i * info.channels];
    g += data[i * info.channels + 1];
    b += data[i * info.channels + 2];
  }
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  const L = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  console.log(`${label.padEnd(26)} rgb(${r},${g},${b})  亮度 ${L}`);
  return { r, g, b, L };
}

/** 对比度（WCAG 相对亮度） */
function contrast(a, b) {
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const l1 = L(a), l2 = L(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return ((hi + 0.05) / (lo + 0.05)).toFixed(2);
}

console.log("\n=== 人物区域（截图坐标）===");
const face = await lum(575, 130, 60, 60, "脸部（额头/眼）");
const hair = await lum(540, 90, 40, 40, "头发（暗部）");
const arm = await lum(600, 370, 50, 40, "手臂/手");

console.log("\n=== 背景区域 ===");
const bgTop = await lum(200, 60, 60, 60, "背景左上");
const bgMid = await lum(950, 300, 60, 60, "背景右中");
const bgNear = await lum(620, 100, 30, 30, "人物附近（脸两侧）");

console.log("\n=== 对比度（WCAG）===");
console.log(`脸 vs 附近背景:     ${contrast(face, bgNear)}`);
console.log(`脸 vs 背景左上:     ${contrast(face, bgTop)}`);
console.log(`头发 vs 附近背景:   ${contrast(hair, bgNear)}`);
console.log(`头发 vs 背景右上:   ${contrast(hair, bgMid)}`);
console.log(`手臂 vs 背景右中:   ${contrast(arm, bgMid)}`);
