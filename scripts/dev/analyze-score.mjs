#!/usr/bin/env node
/**
 * 配乐离线分析 —— 客观指标 + 响度归一表
 *
 * ⚠️ 为什么必须用**客观指标**而不是"我觉得还行"：
 *   "难听"是主观的，但"刺耳""单薄""响度跳变"是有可测指标的：
 *   · **BS.1770 门控响度（LUFS）** —— 14 首曲子响度天然不一致
 *     → 切阶段时音量会跳 → 用测量值算出每首需要的增益，写进 manifest
 *   · **频谱重心（spectral centroid）** —— 声音的平均"亮度"
 *     → 越高越尖锐刺耳；占卜音景的甜区大约在 300~1500 Hz
 *   · **低频能量占比** —— 有没有"厚度"
 *   · **RMS 变异系数（CV）** —— 有没有呼吸感（恒定 = 死板）
 *   · **循环接缝跳变** —— 真无缝的硬指标
 *
 * ⚠️ 为什么用无头 Chrome 而不是 Node 库：
 *   Node 里没有 MP3 解码器（`audio-decode` / `mpg123-decoder` 都要额外装依赖）
 *   → 但 **Chrome 原生就能 decodeAudioData** → 用 CDP 驱动它最稳、零依赖。
 *
 * ⚠️ 为什么接缝测试**直接调用线上那份 makeLoopable**：
 *   复制一份到脚本里测 → 测的就不是线上跑的代码（会漂移）→ 测了等于没测。
 *   → 用 esbuild 把 `src/lib/audio/score.ts` 打成 IIFE 注入页面。
 *
 * 用法：node scripts/dev/analyze-score.mjs [--base http://localhost:3000]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const BASE =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ??
  "http://localhost:3000";

const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/** 响度目标（背景音乐标准） */
const TARGET_LUFS = -20;

/**
 * 风格的**绝对**目标区间（Hz）
 *
 * ⚠️ 这不是最终目标 —— 最终目标是「该风格 7 首的中位数」，
 *   再用这里的区间做夹逼（防止把某一套整体压得太暗或留得太亮）。
 */
const STYLE_RANGE = {
  A: [700, 1300],
  B: [450, 1000],
};

const TRACKS = [
  ["score-A-idle.mp3", "A"],
  ["score-A-contract.mp3", "A"],
  ["score-A-invocation.mp3", "A"],
  ["score-A-selection.mp3", "A"],
  ["score-A-percard.mp3", "A"],
  ["score-A-synthesis.mp3", "A"],
  ["score-A-closing.mp3", "A"],
  ["score-B-idle.mp3", "B"],
  ["score-B-contract.mp3", "B"],
  ["score-B-invocation.mp3", "B"],
  ["score-B-selection.mp3", "B"],
  ["score-B-percard.mp3", "B"],
  ["score-B-synthesis.mp3", "B"],
  ["score-B-closing.mp3", "B"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════
 * 页面内分析代码（注入浏览器执行）
 * ══════════════════════════════════════════════════════════════ */
const PAGE_FN = `
window.__analyzeAll__ = async function (items) {
  // ① 先解码并测量全部曲目（保留平均幅度谱，供第二步搜索低通）
  const raw = [];
  for (const it of items) {
    const res = await fetch(it.url);
    if (!res.ok) { raw.push({ name: it.name, style: it.style, error: "HTTP " + res.status }); continue; }
    const raw2 = await res.arrayBuffer();
    const ctx = new OfflineAudioContext(2, 128, 44100);
    const buf = await ctx.decodeAudioData(raw2);
    raw.push({ name: it.name, style: it.style, ...measure(buf, ctx) });
  }

  // ② 按**风格中位数**定目标重心
  //    ⚠️ 为什么用中位数而不是写死的绝对区间：
  //      绝对区间是拍脑袋定的，生成器出来的曲子本来就比预期亮。
  //      用中位数当目标 → 自动保证"同风格 7 首是一个音色"，
  //      同时保留 A（亮）/ B（暗）两套之间的天然对比。
  const targets = {};
  for (const st of ["A", "B"]) {
    const cs = raw.filter((r) => r.style === st && !r.error).map((r) => r.centroid).sort((a, b) => a - b);
    if (!cs.length) continue;
    const median = cs[Math.floor(cs.length / 2)];
    // 绝对上下限：再亮就会刺耳，再暗就没了层次
    targets[st] = Math.max(st === "A" ? 700 : 450, Math.min(st === "A" ? 1300 : 1000, median));
  }

  // ③ 给每首搜一个低通截止频率，把重心压到风格目标
  for (const r of raw) {
    if (r.error) continue;
    const target = targets[r.style];
    if (r.centroid <= target) {
      r.lowpassHz = 20000;      // 不需要处理
      r.centroidAfter = r.centroid;
      continue;
    }
    const cut = findLowpass(r.spec, r.sampleRate, target);
    r.lowpassHz = cut;
    r.centroidAfter = centroidWithCutoff(r.spec, r.sampleRate, cut);
  }

  // ④ 去掉体积大的频谱再返回
  return raw.map(({ spec, ...rest }) => rest);
};

/* ---- 平均幅度谱（跨窗口平均）---- */
function averageSpectrum(ch, fs) {
  const N = 8192, hop = N / 2;
  const windows = Math.floor((ch.length - N) / hop);
  const half = N / 2;
  const acc = new Float64Array(half);
  if (windows < 1) return { spec: acc, fs };
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let w = 0; w < windows; w++) {
    const off = w * hop;
    for (let i = 0; i < N; i++) {
      const s = ch[off + i];
      re[i] = s * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) {
      acc[k] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
  }
  for (let k = 0; k < half; k++) acc[k] /= windows;
  return { spec: acc, fs };
}

/* ---- RBJ 低通的幅度响应 |H(f)| ---- */
function lowpassMag(f, fs, cutoff, Q) {
  const w0 = 2 * Math.PI * cutoff / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  const w = 2 * Math.PI * f / fs;
  const c = Math.cos(w), s = Math.sin(w);
  const nr = b0 + b1 * c + b2 * Math.cos(2 * w);
  const ni = -b1 * s - b2 * Math.sin(2 * w);
  const dr = a0 + a1 * c + a2 * Math.cos(2 * w);
  const di = -a1 * s - a2 * Math.sin(2 * w);
  return Math.sqrt(nr * nr + ni * ni) / Math.max(1e-9, Math.sqrt(dr * dr + di * di));
}

/* ---- 低通后的频谱重心 ---- */
function centroidWithCutoff(spec, fs, cutoff) {
  let mag = 0, wsum = 0;
  for (let k = 1; k < spec.length; k++) {
    const f = (k * fs) / (spec.length * 2);
    const m = spec[k] * (cutoff >= 20000 ? 1 : lowpassMag(f, fs, cutoff, 0.707));
    mag += m; wsum += f * m;
  }
  return mag > 0 ? wsum / mag : 0;
}

/* ---- 搜索：取**最高**的截止频率（失真最小）且重心达标 ---- */
function findLowpass(spec, fs, target) {
  const candidates = [20000, 14000, 11000, 9000, 7500, 6200, 5200, 4400, 3600, 3000, 2500];
  for (const c of candidates) {
    if (centroidWithCutoff(spec, fs, c) <= target) return c;
  }
  return candidates[candidates.length - 1];
}

/* ---- BS.1770 K 计权双二阶滤波 ---- */
function biquad(type, fs, f0, Q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === "highshelf") {
    b0 =    A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * alpha);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 =    A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * alpha);
    a0 =        (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * alpha;
    a1 =    2 * ((A - 1) - (A + 1) * cw);
    a2 =        (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * alpha;
  } else {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function applyBiquad(data, c) {
  const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  const out = new Float64Array(data.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x0 = data[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

/* ---- BS.1770-4 门控响度 ---- */
function gatedLufs(chans, fs) {
  const blockN = Math.round(0.4 * fs);
  const hopN = Math.round(0.1 * fs);
  const blocks = [];
  for (let s = 0; s + blockN <= chans[0].length; s += hopN) {
    let sum = 0;
    for (let ch = 0; ch < chans.length; ch++) {
      let sq = 0;
      for (let i = 0; i < blockN; i++) { const v = chans[ch][s + i]; sq += v * v; }
      sum += sq / blockN;              // 立体声 L/R 权重均为 1.0
    }
    blocks.push(sum);
  }
  if (!blocks.length) return -Infinity;
  const L = (ms) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
  const abs = blocks.filter((ms) => L(ms) > -70);          // 绝对门限
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const both = abs.filter((ms) => L(ms) > rel);             // 相对门限
  if (!both.length) return -Infinity;
  return L(both.reduce((a, b) => a + b, 0) / both.length);
}

/* ---- 频谱重心 ---- */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const pr = re[i + k + len / 2], pi = im[i + k + len / 2];
        const vr = pr * cr - pi * ci, vi = pr * ci + pi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function spectralCentroid(ch, fs) {
  const N = 8192, hop = N / 2;
  const windows = Math.floor((ch.length - N) / hop);
  if (windows < 1) return 0;
  let sum = 0;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let w = 0; w < windows; w++) {
    const off = w * hop;
    for (let i = 0; i < N; i++) {
      const s = ch[off + i];
      re[i] = s * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    let mag = 0, wsum = 0;
    for (let k = 1; k < N / 2; k++) {
      const f = (k * fs) / N;
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag += m; wsum += f * m;
    }
    if (mag > 0) sum += wsum / mag;
  }
  return sum / windows;
}

/* ---- RMS 变异系数 ---- */
function rmsCv(ch, fs) {
  const hop = Math.round(0.1 * fs);
  const list = [];
  for (let s = 0; s + hop <= ch.length; s += hop) {
    let sq = 0;
    for (let i = 0; i < hop; i++) { const v = ch[s + i]; sq += v * v; }
    list.push(Math.sqrt(sq / hop));
  }
  if (!list.length) return 0;
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const varr = list.reduce((a, b) => a + (b - mean) * (b - mean), 0) / list.length;
  return mean > 0 ? Math.sqrt(varr) / mean : 0;
}

/* ---- 频段能量占比（能量密度，mag²/binHz）---- */
function bandEnergy(ch, fs) {
  const N = 8192, hop = N / 2;
  const windows = Math.floor((ch.length - N) / hop);
  if (windows < 1) return { low: 0, mid: 0, high: 0 };
  let low = 0, mid = 0, high = 0;
  const binHz = fs / N;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let w = 0; w < windows; w++) {
    const off = w * hop;
    for (let i = 0; i < N; i++) {
      const s = ch[off + i];
      re[i] = s * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * fs) / N;
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const d = (m * m) / binHz;
      if (f < 120) low += d; else if (f < 2000) mid += d; else high += d;
    }
  }
  const tot = low + mid + high || 1;
  return { low: (low / tot) * 100, mid: (mid / tot) * 100, high: (high / tot) * 100 };
}

/* ---- 主测量 ---- */
function measure(buf, ctx) {
  const fs = buf.sampleRate;
  const chans = [];
  for (let ch = 0; ch < buf.numberOfChannels; ch++) chans.push(buf.getChannelData(ch));

  // K 计权（BS.1770：high-shelf +4dB @1681.97Hz，再 high-pass @38.135Hz）
  const k1 = biquad("highshelf", fs, 1681.974450955533, 0.7071752369554196, 3.999843853973347);
  const k2 = biquad("highpass", fs, 38.13547087602444, 0.5003270373238773, 0);
  const kw = chans.map((c) => applyBiquad(applyBiquad(c, k1), k2));

  const lufs = gatedLufs(kw, fs);

  // 峰值（未加权的原信号）
  let peak = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }

  const centroid = spectralCentroid(chans[0], fs);
  const cv = rmsCv(chans[0], fs);
  const bands = bandEnergy(chans[0], fs);
  const { spec } = averageSpectrum(chans[0], fs);

  // 循环接缝：用**线上那份** makeLoopable 处理后比较接缝跳变
  const looped = window.__SCORE__ ? window.__SCORE__.makeLoopable(buf, ctx, 3) : null;
  let seam = null;
  if (looped) {
    const lc = looped.getChannelData(0);
    const oc = chans[0];
    // 典型样本间差（作为"可闻跳变"的参考尺度）
    let dsum = 0;
    for (let i = 1; i < oc.length; i += 7) dsum += Math.abs(oc[i] - oc[i - 1]);
    const typical = dsum / Math.floor(oc.length / 7);
    const rawJump = Math.abs(oc[oc.length - 1] - oc[0]);
    const loopJump = Math.abs(lc[lc.length - 1] - lc[0]);
    seam = {
      rawJump: rawJump,
      loopJump: loopJump,
      typicalDelta: typical,
      ratio: typical > 0 ? loopJump / typical : 0,
      rawRatio: typical > 0 ? rawJump / typical : 0,
      loopSeconds: looped.duration,
    };
  }

  return {
    duration: buf.duration,
    sampleRate: fs,
    lufs,
    peak,
    centroid,
    rmsCv: cv,
    lowPct: bands.low,
    midPct: bands.mid,
    highPct: bands.high,
    spec,
    seam,
  };
}
`;

/* ══════════════════════════════════════════════════════════════
 * 起 Chrome + CDP
 * ══════════════════════════════════════════════════════════════ */
const PORT = 9700 + Math.floor(Math.random() * 200);
const userDataDir = mkdtempSync(join(tmpdir(), "score-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("Chrome DevTools 端口未就绪");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 180000);
    });
  }
}

try {
  const wsUrl = await waitForDevtools();
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("找不到可用页面 target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new CDP(ws);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // ⚠️ 页面必须与 dev server **同源**，否则 fetch("/audio/...") 会被 CORS 拦掉
  console.log(`→ 打开 ${BASE}`);
  await cdp.send("Page.navigate", { url: BASE });

  // ⚠️ 必须**轮询到 origin 正确**才能继续：
  //   导航是异步的，Next dev 首次编译这个页面可能要好几秒。
  //   在 about:blank 上执行相对路径 fetch 会直接失败（origin 为 null），
  //   而且 CDP 会**静默返回 undefined**（不抛异常）→ 极难排查。
  const wantOrigin = new URL(BASE).origin;
  let ready = false;
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    const probe = await cdp.send("Runtime.evaluate", {
      expression: "location.origin + '|' + document.readyState",
      returnByValue: true,
    });
    const v = probe.result?.value ?? "";
    if (v.startsWith(wantOrigin)) {
      ready = true;
      console.log(`→ 页面就绪（${v}），等待 ${(i * 0.25).toFixed(1)}s`);
      break;
    }
  }
  if (!ready) throw new Error(`页面没有在 40s 内切到 ${wantOrigin}（dev server 没起来？）`);

  /* ---- 把线上那份 makeLoopable 打包注入页面 ---- */
  const esbuild = (await import("esbuild")).default ?? (await import("esbuild"));
  const tmpDir = mkdtempSync(join(tmpdir(), "score-js-"));
  const outJs = join(tmpDir, "score.js");
  await esbuild.build({
    entryPoints: [join(root, "src", "lib", "audio", "score.ts")],
    bundle: true,
    format: "iife",
    globalName: "__SCORE__",
    platform: "browser",
    outfile: outJs,
    logLevel: "silent",
  });
  const { readFileSync } = await import("node:fs");
  const bundleJs = readFileSync(outJs, "utf-8");

  // ① 先注入打包产物（独立一次 evaluate，避免大表达式被静默截断）
  await cdp.send("Runtime.evaluate", { expression: bundleJs });
  // ② 再注入分析函数
  await cdp.send("Runtime.evaluate", { expression: PAGE_FN });

  const items = TRACKS.map(([name, style]) => ({
    name,
    style,
    url: `/audio/${name}`,
  }));

  console.log(`→ 分析 ${items.length} 首曲子（解码 + K 计权响度 + 频谱 + 接缝）\n`);

  // ⚠️ 顶层 await 在表达式里是语法错误 → 必须包成 async IIFE 再 awaitPromise
  const res = await cdp.send("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await window.__analyzeAll__(${JSON.stringify(items)})))()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      `页面内分析抛错：${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`
    );
  }
  const raw = res.result?.value;
  if (!raw) throw new Error("页面没有返回分析结果（可能是解码失败或超时）");
  const results = JSON.parse(raw);

  /* ══════════════════════════════════════════════════════════════
   * 报告 + manifest
   * ══════════════════════════════════════════════════════════════ */

  // 风格目标（与页面里的算法一致：取中位数，再用绝对区间夹逼）
  const styleTarget = {};
  for (const st of ["A", "B"]) {
    const cs = results
      .filter((r) => !r.error && TRACKS.find(([n]) => n === r.name)?.[1] === st)
      .map((r) => r.centroid)
      .sort((a, b) => a - b);
    if (!cs.length) continue;
    const median = cs[Math.floor(cs.length / 2)];
    const [lo, hi] = STYLE_RANGE[st];
    styleTarget[st] = Math.max(lo, Math.min(hi, median));
  }
  console.log(
    `风格目标重心：A=${Math.round(styleTarget.A)}Hz（星玻璃，偏亮）  B=${Math.round(styleTarget.B)}Hz（深海，偏暗）\n`
  );

  console.log("曲目                     时长    LUFS    增益    重心→整形后  低通    低%    中%   RMS波动  接缝");
  console.log("─".repeat(108));

  const tracksOut = {};
  let issues = 0;

  for (const r of results) {
    if (r.error) {
      console.log(`✗ ${r.name} —— ${r.error}`);
      issues++;
      continue;
    }
    const style = TRACKS.find(([n]) => n === r.name)?.[1] ?? "A";
    const target = styleTarget[style];

    // 响度修正：把门控响度对齐到目标
    const gainDb = Math.max(-16, Math.min(16, TARGET_LUFS - r.lufs));
    const scale = Math.pow(10, gainDb / 20);
    // ⚠️ 峰值必须在**归一之后**判读 —— 原曲本来就削顶了，
    //    归一 10dB 之后峰值自然就下来了。
    const peakAfter = r.peak * scale;

    const centroidAfter = r.centroidAfter ?? r.centroid;
    const centroidOk = centroidAfter <= target + 40;
    const peakOk = peakAfter <= 0.89; // ≈ -1 dBFS
    const cvOk = r.rmsCv > 0.15;
    const seamOk = r.seam && r.seam.ratio < 3;
    const rangeOk = centroidOk && peakOk && cvOk && seamOk;
    if (!rangeOk) issues++;

    tracksOut[r.name.replace(/\.mp3$/, "")] = {
      style,
      gainDb: Number(gainDb.toFixed(2)),
      lowpassHz: r.lowpassHz ?? 20000,
      duration: Number(r.duration.toFixed(2)),
      lufs: Number(r.lufs.toFixed(2)),
      centroid: Math.round(r.centroid),
      centroidAfter: Math.round(centroidAfter),
      styleTarget: Math.round(target),
      rmsCv: Number(r.rmsCv.toFixed(3)),
      peak: Number(peakAfter.toFixed(4)),
      lowPct: Number(r.lowPct.toFixed(1)),
      midPct: Number(r.midPct.toFixed(1)),
      highPct: Number(r.highPct.toFixed(1)),
      seamRatio: r.seam ? Number(r.seam.ratio.toFixed(2)) : null,
      checks: {
        centroid: centroidOk,
        peak: peakOk,
        dynamics: cvOk,
        seamless: seamOk,
      },
    };

    const lp = r.lowpassHz ?? 20000;
    console.log(
      `${rangeOk ? " " : "!"} ${r.name.padEnd(22)} ${r.duration.toFixed(0).padStart(3)}s ` +
        `${r.lufs.toFixed(1).padStart(6)} ${(gainDb >= 0 ? "+" : "") + gainDb.toFixed(1)}dB ` +
        `${String(Math.round(r.centroid)).padStart(5)}→${String(Math.round(centroidAfter)).padStart(5)}${centroidOk ? " " : "!"} ` +
        `${(lp >= 20000 ? "  无" : String(lp) + "Hz").padStart(7)} ` +
        `${r.lowPct.toFixed(0).padStart(4)}% ${r.midPct.toFixed(0).padStart(5)}% ` +
        `${r.rmsCv.toFixed(3)}${cvOk ? " " : "!"} ${(r.seam?.ratio ?? 0).toFixed(2).padStart(5)}${seamOk ? " " : "!"}`
    );
  }

  /* ---- 跨曲目的整体判据 ---- */
  const all = Object.values(tracksOut);
  const spreadOf = (style) => {
    const vals = all.filter((t) => t.style === style).map((t) => t.centroidAfter);
    return vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  };
  console.log(`\n同风格整形后频谱重心极差：A=${spreadOf("A")}Hz  B=${spreadOf("B")}Hz（目标 < 300，避免切阶段时"换了个乐器"）`);

  /* ---- 写 manifest ---- */
  const manifest = {
    note: "离线分析生成（scripts/dev/analyze-score.mjs）—— gainDb 把门控响度对齐到 targetLufs；lowpassHz 是音色修正（把过亮的曲子压到风格目标重心）",
    targetLufs: TARGET_LUFS,
    styleTargetCentroid: {
      A: Math.round(styleTarget.A),
      B: Math.round(styleTarget.B),
    },
    generatedAt: new Date().toISOString().slice(0, 10),
    tracks: tracksOut,
  };
  const manifestPath = join(root, "public", "audio", "score.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\n→ 写入 ${manifestPath}`);

  console.log(
    `\n${issues === 0 ? "✅" : "⚠️"}  ${all.length} 首已分析，${issues} 项超出目标区间` +
      `（! 标记：重心超区间 / 峰值削波 / 动态不足 / 接缝可闻）`
  );
} finally {
  chrome.kill();
}
