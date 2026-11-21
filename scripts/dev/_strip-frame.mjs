import sharp from "sharp";
import { existsSync } from "node:fs";

/**
 * ⚠️ 精确擦除「矩形画框」—— 检测并填充四条直线
 *
 * ⚠️⚠️ 为什么裁边不行（实测）：
 *   · 框是**独立的闭合图形**（不是背景）
 *   · trim 不会去掉它内部的空白 → 框完整保留 ❌
 *   · 裁 7.5% 只削掉了框的**最外沿**，框的主体（线在 5~10% 处）还在
 *
 * ⚠️ 这版的做法：**投影法**
 *   1. 沿水平/垂直方向统计每行的亮像素数 / 每列的亮像素数
 *   2. 找到「贯穿整幅画」的极值行/列 → 那就是框线所在
 *   3. 把这些行/列上的亮像素全部清零
 *   4. 再做形态学闭运算补回被切断的主体
 */
const IDS = ["love", "career", "wealth", "crossroads", "tides", "morning", "kindred", "whispers"];
const TAG = process.argv[2] ?? "v3-d";
const OUT = process.argv[3] ?? "v3-d";

async function removeFrame(src, out) {
  if (!existsSync(src)) return false;

  const { data, info } = await sharp(src)
    .resize(1024, 1024, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const CH = info.channels;
  const buf = Buffer.from(data);

  /** 该点是否为「亮前景」 */
  const isInk = (x, y) => {
    const i = (y * W + x) * CH;
    const lum = (buf[i] + buf[i + 1] + buf[i + 2]) / 3;
    return lum > 85 && buf[i + 3] > 10;
  };

  // ① 统计每行/每列的亮像素数
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

  // ② 找「贯穿型」的极值行/列（>= 60% 宽度/高度）
  const rowThr = W * 0.55;
  const colThr = H * 0.55;
  const frameRows = [];
  const frameCols = [];
  for (let y = 0; y < H; y++) if (rowCount[y] >= rowThr) frameRows.push(y);
  for (let x = 0; x < W; x++) if (colCount[x] >= colThr) frameCols.push(x);

  console.log(`  框线行: ${frameRows.length}  框线列: ${frameCols.length}`);
  if (!frameRows.length && !frameCols.length) return false;

  // ③ 把框线附近（±3px）的亮像素清零
  const clearBand = 4;
  const clear = (x, y) => {
    const i = (y * W + x) * CH;
    buf[i + 3] = 0;
  };
  for (const y of frameRows) {
    for (let dy = -clearBand; dy <= clearBand; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let x = 0; x < W; x++) if (isInk(x, yy)) clear(x, yy);
    }
  }
  for (const x of frameCols) {
    for (let dx = -clearBand; dx <= clearBand; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      for (let y = 0; y < H; y++) if (isInk(xx, y)) clear(xx, y);
    }
  }

  // ④ 形态学闭运算（补回被切断的主体）
  const closed = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      closed[y * W + x] = isInk(x, y) ? 1 : 0;
    }
  }
  const dil = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (closed[(y + dy) * W + (x + dx)]) { any = 1; break; }
        }
      }
      dil[y * W + x] = any;
    }
  }
  const ero = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dil[(y + dy) * W + (x + dx)]) { all = 0; break; }
        }
      }
      ero[y * W + x] = all;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * CH;
      if (!ero[y * W + x]) buf[i + 3] = 0;
    }
  }

  // ⑤ trim → 缩放 → 居中
  const trimmed = await sharp(buf, {
    raw: { width: W, height: H, channels: CH },
  })
    .trim({ threshold: 10 })
    .png()
    .toBuffer();

  const tm = await sharp(trimmed).metadata();
  const pad = Math.round(Math.max(tm.width, tm.height) * 0.10);

  await sharp(trimmed)
    .resize({
      width: 512 - pad * 2,
      height: 512 - pad * 2,
      fit: "inside",
      kernel: "lanczos3",
    })
    .extend({
      top: pad, bottom: pad, left: pad, right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);

  return true;
}

for (const id of IDS) {
  const src = `shots/${TAG}-${id}-clean.png`;
  const out = `shots/${OUT}-${id}-final.png`;
  try {
    if (await removeFrame(src, out)) console.log(`✓ ${id}`);
  } catch (e) {
    console.log(`✗ ${id}: ${e.message.slice(0, 60)}`);
  }
}
