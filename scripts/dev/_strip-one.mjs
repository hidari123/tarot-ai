import sharp from "sharp";

/**
 * ⚠️ 单张去框（投影法）
 * ⚠️ 用法：node scripts/dev/_strip-one.mjs <src> <out>
 */

const src = process.argv[2];
const out = process.argv[3];

const { data, info } = await sharp(src)
  .resize(1024, 1024, { fit: "fill" })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const W = info.width;
const H = info.height;
const CH = info.channels;
const buf = Buffer.from(data);

const isInk = (x, y) => {
  const i = (y * W + x) * CH;
  const lum = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
  return lum > 85 && buf[i + 3] > 10;
};

// 统计每行/列的亮像素
const rowCount = new Int32Array(H);
const colCount = new Int32Array(W);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (isInk(x, y)) {
      rowCount[y]++;
      colCount[x]++;
    }
  }
}

const rowThr = W * 0.5;
const colThr = H * 0.5;
const frameRows = [];
const frameCols = [];
for (let y = 0; y < H; y++) if (rowCount[y] >= rowThr) frameRows.push(y);
for (let x = 0; x < W; x++) if (colCount[x] >= colThr) frameCols.push(x);

const band = 5;
for (const y of frameRows) {
  for (let dy = -band; dy <= band; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    for (let x = 0; x < W; x++) if (isInk(x, yy)) buf[(yy * W + x) * CH + 3] = 0;
  }
}
for (const x of frameCols) {
  for (let dx = -band; dx <= band; dx++) {
    const xx = x + dx;
    if (xx < 0 || xx >= W) continue;
    for (let y = 0; y < H; y++) if (isInk(xx, y)) buf[(y * W + xx) * CH + 3] = 0;
  }
}

// 闭运算补回切断处
const closed = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) closed[y * W + x] = isInk(x, y) ? 1 : 0;
const dil = new Uint8Array(W * H);
for (let y = 1; y < H - 1; y++)
  for (let x = 1; x < W - 1; x++) {
    let any = 0;
    for (let dy = -1; dy <= 1 && !any; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (closed[(y + dy) * W + (x + dx)]) { any = 1; break; }
    dil[y * W + x] = any;
  }
const ero = new Uint8Array(W * H);
for (let y = 1; y < H - 1; y++)
  for (let x = 1; x < W - 1; x++) {
    let all = 1;
    for (let dy = -1; dy <= 1 && all; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (!dil[(y + dy) * W + (x + dx)]) { all = 0; break; }
    ero[y * W + x] = all;
  }
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (!ero[y * W + x]) buf[(y * W + x) * CH + 3] = 0;

const trimmed = await sharp(buf, { raw: { width: W, height: H, channels: CH } })
  .trim({ threshold: 10 })
  .png()
  .toBuffer();

const tm = await sharp(trimmed).metadata();
const pad = Math.round(Math.max(tm.width, tm.height) * 0.1);

await sharp(trimmed)
  .resize({ width: 512 - pad * 2, height: 512 - pad * 2, fit: "inside", kernel: "lanczos3" })
  .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toFile(out);

console.log(`框线行 ${frameRows.length} 列 ${frameCols.length} → ${out}`);
