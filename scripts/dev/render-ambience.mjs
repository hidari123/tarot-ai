#!/usr/bin/env node
/**
 * 环境音**离线渲染 + 频谱分析**（2026-11-07）
 *
 * ⚠️ 为什么用无头 Chrome 而不是 Node 库：
 *   Node 里没有 Web Audio 实现（`offline-audio-context` / `standardized-audio-context`
 *   在本机 npm registry 连不上的情况下装不上）。
 *   → 但 **Chrome 原生就有 OfflineAudioContext** → 用 CDP 驱动它最稳、零依赖。
 *
 * ⚠️ 为什么需要这个工具：
 *   "难听"是主观的，但**刺耳**是有客观指标的：
 *   · **频谱重心（spectral centroid）** —— 声音的平均"亮度"
 *     · 越高 = 越尖锐刺耳
 *     · 冥想/占卜音景的甜区大约在 **300~1200 Hz**
 *     · 超过 2000Hz = 刺耳（用户三轮投诉"很吵"的根源）
 *   · **低频能量占比（40~120Hz）** —— "有没有重量"
 *     · 占比太低 = 声音薄、飘
 *   · **RMS 波动（变异系数）** —— 有没有呼吸感
 *     · 恒定 = 死板；波动大 = 有起伏
 *
 * ⚠️ 流程：
 *   ① 起无头 Chrome → CDP
 *   ② 打开一个空白页 → 注入渲染脚本（页面内用 OfflineAudioContext 渲染）
 *   ③ 取回 PCM → 在 Node 里做 FFT 分析
 *   ④ 导出 WAV 供人耳试听
 *
 * 用法：node scripts/dev/render-ambience.mjs [层名]
 *   不带参数 → 渲染全部 7 层并打印报告 + 导出 WAV
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9500 + Math.floor(Math.random() * 200);
const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════
 * 在页面里跑的渲染脚本
 * ⚠️ 必须是字符串（要注入浏览器执行）
 * ══════════════════════════════════════════════════════════════ */
/**
 * ⚠️ 为什么要注入**完整的一份合成逻辑**而不是 import 我们的模块：
 *   Next.js 的 TS 模块在裸页面里没法直接 import（需要编译）。
 *   → 但如果复制一份逻辑到注入脚本里，就**测的不是线上代码**（会漂移）。
 *   → 解法：**读 src/lib/audio/ambient.ts 的源码，去掉 import/export，
 *      拼进注入脚本** → 测的仍然是那一份真代码。
 */
const PAGE_SCRIPT = `
(async () => {
  const layer = __LAYER__;
  const seconds = __SECONDS__;
  const sampleRate = 44100;
  const A = window.__AMB__;

  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  const dry = ctx.createGain();
  dry.gain.value = 1;
  dry.connect(master);
  const convolver = ctx.createConvolver();
  convolver.buffer = A.makeImpulseResponse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.5;
  convolver.connect(wet);
  wet.connect(master);
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.42;
  const delayFb = ctx.createGain();
  delayFb.gain.value = 0.18;
  const delayWet = ctx.createGain();
  delayWet.gain.value = 0.2;
  delay.connect(delayFb);
  delayFb.connect(delay);
  delay.connect(delayWet);
  delayWet.connect(master);

  const st = A.getState();
  st.ctx = ctx; st.master = master; st.dry = dry; st.wet = wet;
  st.convolver = convolver; st.delay = delay; st.delayWet = delayWet;
  st.noise = null; st.subBass = null; st.subBassMod = null;
  st.chord = null; st.lfo = null; st.fmBell = null;
  st.unlocked = true;

  A.buildLayer(layer);
  // ⚠️ 关键：buildLayer 启动的是**定时器版**调度器，
  //   但离线渲染里真实时间不推进 → 定时器不会触发 → 只有底床没有乐句。
  // → 必须调用 scheduleOffline 一次性把整条时间轴排完。
  A.stopScheduler(st);
  A.scheduleOffline(st, A.LAYER_PARAMS[layer], seconds);

  const buf = await ctx.startRendering();
  const ch = buf.getChannelData(0);

  // ⚠️⚠️ 为什么**在页面里**做频谱分析，而不是把 PCM 传回 Node：
  //   12 秒 × 44100 = **529200 个 float**。
  //   · Array.from → JSON 数组 ≈ 5MB 文本 → CDP returnByValue 序列化极慢且被截断
  //     （实测：静默返回 undefined）
  //   · base64 传输 ≈ 700KB → 也遇到过 undefined
  //   → **最稳的做法：让页面算好指标，只回传几十个数字**（秒级 vs 分钟级）。
  //   → 试听用的 WAV 走**另一条路**：分块取（见 chunked transfer）。
  const metrics = window.__analyze__(ch, sampleRate);
  // ⚠️ 诊断信息：metrics 为 null 时能立刻看出是"PCM 为空"还是"分析失败"
  let peak = 0;
  for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  const diag = { len: ch.length, first: ch[0], peak };

  // 试听用的 PCM：分块取（每块 100000 个样本）
  const CHUNK = 100000;
  const chunks = [];
  for (let i = 0; i < ch.length; i += CHUNK) {
    const sub = ch.subarray(i, Math.min(i + CHUNK, ch.length));
    const bytes = new Uint8Array(sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength));
    let bin = "";
    for (let k = 0; k < bytes.length; k += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
    }
    chunks.push(btoa(bin));
  }
  return { metrics, chunks, total: ch.length, diag };
})()
`;

/**
 * 页面内分析函数（FFT + 指标）
 *
 * ⚠️ 为什么要放进页面而不是在 Node 里算：
 *   PCM 有 **52 万个样本**（12 秒 × 44100），
 *   跨进程传回 Node 太慢且极易被截断（实测：静默返回 undefined）。
 *   → 页面里算好指标，只回传几十个数字（秒级 vs 分钟级）。
 */
const ANALYZE_FN = `
function __analyze__(pcm, sampleRate) {
  const N = 8192, hop = N / 2;
  const windows = Math.floor((pcm.length - N) / hop);
  if (windows < 1) return null;
  let centroidSum = 0, lowSum = 0, midSum = 0, highSum = 0, totalSum = 0;
  const rmsList = [];
  for (let w = 0; w < windows; w++) {
    const off = w * hop;
    // ⚠️⚠️ 每个窗口必须**新建** re/im 数组：
    //   复用同一个数组时，im 会累积上一个窗口的残留
    //   → FFT 的 imag 分量被污染 → 幅度算出来全错（实测频谱指标全 0）。
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const s = pcm[off + i];
      re[i] = s * 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      sumSq += s * s;
    }
    rmsList.push(Math.sqrt(sumSq / N));
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i+k], ui = im[i+k];
          const pr = re[i+k+len/2], pi = im[i+k+len/2];
          const vr = pr*cr - pi*ci, vi = pr*ci + pi*cr;
          re[i+k] = ur+vr; im[i+k] = ui+vi;
          re[i+k+len/2] = ur-vr; im[i+k+len/2] = ui-vi;
          const ncr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = ncr;
        }
      }
    }
    let mag = 0, weighted = 0, bLow = 0, bMid = 0, bHigh = 0;
    for (let k = 1; k < N/2; k++) {
      const freq = k * sampleRate / N;
      const m = Math.sqrt(re[k]*re[k] + im[k]*im[k]);
      mag += m; weighted += freq * m;
      // ⚠️⚠️ 为什么用**能量密度**（mag² / 带宽）而不是原始幅度 mag：
      //   · mag 是**幅度**，每个 bin 的贡献相同
      //   · 但低频只有 120/5.4 ≈ 22 个 bin，中频有 ~1900 个 bin
      //   → 直接累加 mag，低频占比会被 bin 数量**人为压低**（实测 1.5%）
      //   → 正确做法：累加**能量密度**（每 Hz 的能量），
      //     这样才反映"这段频率带里有多少能量"。
      const binHz = sampleRate / N;
      const density = (m * m) / binHz;
      if (freq < 120) bLow += density; else if (freq < 2000) bMid += density; else bHigh += density;
    }
    centroidSum += mag > 0 ? weighted / mag : 0;
    lowSum += bLow; midSum += bMid; highSum += bHigh; totalSum += mag;
  }
  let rmsMean = 0; for (const r of rmsList) rmsMean += r; rmsMean /= rmsList.length;
  let rmsVar = 0; for (const r of rmsList) rmsVar += (r - rmsMean) ** 2; rmsVar /= rmsList.length;
  let peak = 0; for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  return {
    centroid: centroidSum / windows,
    // ⚠️ 归一化成百分比（三段能量密度总和为 1）
    //   ⚠️ 为什么之前显示 1700%：
    //     能量密度 = mag²/binHz，量纲是"每 Hz 的能量"
    //     三段直接相加不是"占比"（各段 bin 数不同 → 量级差异巨大）
    //   → 除以三段总和 → 真正的能量分布占比。
    lowPct: (lowSum / (lowSum + midSum + highSum)) * 100,
    midPct: (midSum / (lowSum + midSum + highSum)) * 100,
    highPct: (highSum / (lowSum + midSum + highSum)) * 100,
    rmsMean, rmsCv: rmsMean > 0 ? Math.sqrt(rmsVar) / rmsMean : 0, peak
  };
}
`;

/* ══════════════════════════════════════════════════════════════
 * FFT（基 2，迭代版）
 * ╠═════════════════════════════════════════════════════════════ */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
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
        const vr = pr * cr - pi * ci;
        const vi = pr * ci + pi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 频谱分析：重心 / 分频段能量 / RMS 波动 */
function analyze(pcm, sampleRate) {
  const N = 8192;
  const hop = N / 2;
  const windows = Math.floor((pcm.length - N) / hop);
  if (windows < 1) return null;

  let centroidSum = 0, lowSum = 0, midSum = 0, highSum = 0, totalSum = 0;
  const rmsList = [];

  for (let w = 0; w < windows; w++) {
    const off = w * hop;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const s = pcm[off + i];
      const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      re[i] = s * win;
      sumSq += s * s;
    }
    rmsList.push(Math.sqrt(sumSq / N));
    fft(re, im);

    let mag = 0, weighted = 0, bLow = 0, bMid = 0, bHigh = 0;
    for (let k = 1; k < N / 2; k++) {
      const freq = (k * sampleRate) / N;
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag += m;
      weighted += freq * m;
      // ⚠️ 用**能量密度**（mag²/带宽），不是原始幅度（详见 ANALYZE_FN 里的说明）
      const binHz = sampleRate / N;
      const density = (m * m) / binHz;
      if (freq < 120) bLow += density;
      else if (freq < 2000) bMid += density;
      else bHigh += density;
    }
    centroidSum += mag > 0 ? weighted / mag : 0;
    lowSum += bLow; midSum += bMid; highSum += bHigh;
    totalSum += mag;
  }

  const rmsMean = rmsList.reduce((a, b) => a + b, 0) / rmsList.length;
  const rmsVar = rmsList.reduce((a, b) => a + (b - rmsMean) ** 2, 0) / rmsList.length;
  let peak = 0;
  for (const s of pcm) peak = Math.max(peak, Math.abs(s));

  const total = lowSum + midSum + highSum;
  return {
    centroid: centroidSum / windows,
    // ⚠️ 归一化：见 ANALYZE_FN 里的说明（能量密度三段不能直接当百分比）
    lowPct: (lowSum / total) * 100,
    midPct: (midSum / total) * 100,
    highPct: (highSum / total) * 100,
    rmsMean,
    rmsCv: rmsMean > 0 ? Math.sqrt(rmsVar) / rmsMean : 0,
    peak,
  };
}

/** 16-bit PCM WAV */
function encodeWav(samples, sampleRate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

/* ══════════════════════════════════════════════════════════════
 * 起 Chrome + CDP
 * ══════════════════════════════════════════════════════════════ */
const userDataDir = mkdtempSync(join(tmpdir(), "amb-"));
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
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 120000);
    });
  }
}

try {
  const wsUrl = await waitForDevtools();
  /**
   * ⚠️ 直接连**页面级** WebSocket（`/devtools/page/<id>`），
   *   而不是浏览器级 + Target.attachToTarget。
   * ⚠️ 为什么：
   *   浏览器级连接上用 sessionId 发 Runtime.evaluate 时，
   *   返回结构里 `result` 会是 undefined（实测）——
   *   页面级连接最简单，也最不容易出协议层的坑。
   */
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("找不到可用页面 target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new CDP(ws);
  const send = (m, p) => cdp.send(m, p);

  await send("Page.enable");
  await send("Runtime.enable");

  /**
   * ⚠️ 用 **esbuild 的 JS API** 把 TS 编译成 JS（而不是手写正则剥类型）。
   * ⚠️ 为什么不能手写正则剥类型：
   *   TS 的类型标注遍布整个文件（参数、返回值、泛型、断言），
   *   正则一定会漏 → 注入后 SyntaxError（实测：`Unexpected token '|'`）。
   *   → esbuild 是项目已有的依赖（Next.js 自带），零额外安装、100% 正确。
   *
   * ⚠️⚠️ 为什么用 **JS API** 而不是 CLI 子进程：
   *   Windows 上 `spawnSync("*.cmd")` 抛 EINVAL（实测两次：npx.cmd 与 esbuild.cmd）。
   *   → esbuild 的 JS API 是纯 Node 调用，没有子进程 → 不会有这个问题。
   */
  const esbuild = (await import("esbuild")).default ?? (await import("esbuild"));
  const { readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  /**
   * ⚠️⚠️⚠️ 关键：esbuild 的输出形式决定了符号能不能被后续 evaluate 看到。
   * ⚠️ 实测踩坑（三次）：
   *   ① `format=esm` → 顶层是 `var LAYER_PARAMS = ...` → **不挂 window**
   *      → 后续 evaluate 里 `LAYER_PARAMS is not defined`
   *   ② 包在 IIFE 里 → function 声明是局部的 → 同样拿不到
   *   ③ `format=iife --global-name=__AMB__` → 全部挂在 **__AMB__** 上 ✅
   *   → 用第 ③ 种：esbuild globalName，之后引用 `__AMB__.xxx`。
   */
  const tmpDir = mkdtempSync(join(tmpdir(), "amb-js-"));
  const outJs = join(tmpDir, "ambient.js");
  await esbuild.build({
    entryPoints: ["src/lib/audio/ambient.ts"],
    bundle: false,
    format: "iife",
    globalName: "__AMB__",
    platform: "neutral",
    outfile: outJs,
    logLevel: "silent",
  });

  const esm = readFileSync(outJs, "utf-8");
  /**
   * ⚠️ 去掉 IIFE 包装（`var __AMB__ = (() => { ... })();`），
   *   只保留内部 → 直接赋值给 window.__AMB__。
   */
  const asScript = esm.replace(
    /^var __AMB__ = \(\(\) => \{/,
    "window.__AMB__ = (function () {"
  );

  const LAYERS = ["idle", "contract", "invocation", "selection", "perCard", "synthesis", "closing"];
  const target = process.argv[2];
  const layers = target ? [target] : LAYERS;
  const SECONDS = 12;

  mkdirSync("shots/audio", { recursive: true });

  console.log("=== 环境音离线渲染 + 频谱分析 ===\n");
  console.log("层            频谱重心   低频%   中频%   高频%   RMS波动   峰值");
  console.log("─".repeat(72));

  const results = [];
  for (const layer of layers) {
    /**
     * ⚠️ 分两步执行，**不要**把 asScript 和 body 拼成一个大表达式。
     * ⚠️ 为什么（实测踩坑）：
     *   拼接后的表达式 `(() => { ...1600行...; return (async()=>{...})() })()`
     *   一旦 asScript 里有任何"顶层 await / 顶层 return"或作用域问题，
     *   Runtime.evaluate 会**静默返回 undefined**（连 exceptionDetails 都没有），
     *   排查成本极高。
     *   → 拆成两次 evaluate：
     *     ① 先把 asScript 作为**全局声明**注入（Runtime.evaluate 会在全局作用域声明 let/const）
     *     ② 再单独执行渲染逻辑（此时能直接引用全局符号）
     */
    /**
     * ⚠️⚠️⚠️ 注入必须在**全局作用域**，不能包在 IIFE 里！
     * ⚠️ 为什么（实测踩坑）：
     *   `(() => { function makeImpulseResponse() {...} ... })()`
     *   → 里面的 function 声明是**局部的**，不会挂到全局
     *   → 下一次 evaluate 里 `makeImpulseResponse is not defined`
     *   → 而 Runtime.evaluate 的顶层 `function` 声明**会**挂到 window（全局）
     *   → 所以这里用**裸的** `{ ... }`（顶层语句），不用 IIFE。
     */
    /**
     * ⚠️ 注入分成两次 evaluate，**不**包 try/catch。
     * ⚠️ 为什么（实测踩坑）：
     *   把 IIFE 赋值塞进 `try { ... } catch {}` 里会产生语法错误
     *   （`Unexpected token 'catch'`）—— 因为 esbuild 的 IIFE 以 `})();` 结尾，
     *   拼进 try 块后花括号配对被破坏。
     *   → 直接 eval，语法错误会由 CDP 的 exceptionDetails 正常报出来（更好定位）。
     */
    const injectRes = await send("Runtime.evaluate", {
      // ⚠️ ANALYZE_FN 是**完整的函数声明** → 直接拼进去（不要用正则剥离花括号，
      //    实测会破坏配平 → `Unexpected end of input`）
      expression: `${ANALYZE_FN}\n${asScript}`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (injectRes.exceptionDetails) {
      const d = injectRes.exceptionDetails;
      console.log(
        `${layer.padEnd(12)} 注入失败: ${(d.exception?.description || d.text || "").split("\n")[0].slice(0, 200)}`
      );
      break;
    }
    // ⚠️ 自检：确认关键符号都在
    const check = await send("Runtime.evaluate", {
      expression: `({ amb: typeof window.__AMB__, build: typeof (window.__AMB__ && window.__AMB__.buildLayer), analyze: typeof window.__analyze__ })`,
      returnByValue: true,
    });
    const cv = check.result?.value;
    if (!cv || cv.amb !== "object" || cv.build !== "function" || cv.analyze !== "function") {
      console.log(`${layer.padEnd(12)} 注入后自检失败: ${JSON.stringify(cv)}`);
      break;
    }

    // ② 单独执行渲染（用全局作用域里的符号）
    // ② 单独执行渲染（用全局作用域里的符号）
    const body = PAGE_SCRIPT.replace("__LAYER__", JSON.stringify(layer))
      .replace("__SECONDS__", String(SECONDS))
      .replace("__ANALYZE__", "window.__analyze__");

    const res = await send("Runtime.evaluate", {
      // ⚠️⚠️ 必须 **await** body：
      //   body 是 `(async () => {...})()` → 返回 Promise。
      //   如果不 await，try/catch **捕获不到异步里的异常**
      //   → Promise 变成 rejected → CDP 只能报"返回 undefined"。
      expression: `(async () => { try { return await ${body}; } catch(e) { return { __error: String(e && e.stack || e) }; } })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 120000,
    });

    if (res.exceptionDetails) {
      const ex = res.exceptionDetails;
      console.log(
        `${layer.padEnd(12)} 渲染失败: ${(ex.exception?.description || ex.text || "").split("\n").slice(0, 3).join(" | ").slice(0, 220)}`
      );
      continue;
    }
    if (!res.result || res.result.value === undefined) {
      console.log(`${layer.padEnd(12)} 渲染返回 undefined —— 原始响应:`);
      console.log(JSON.stringify(res).slice(0, 600));
      break;
    }
    const payload = res.result.value;
    if (payload && payload.__error) {
      console.log(`${layer.padEnd(12)} 渲染抛错:`);
      console.log(payload.__error.split("\n").slice(0, 8).join("\n"));
      break;
    }
    if (!payload || !payload.metrics) {
      console.log(`${layer.padEnd(12)} 返回结构异常: ${JSON.stringify(payload).slice(0, 200)}`);
      break;
    }

    const a = payload.metrics;
    if (!a) {
      console.log(`${layer.padEnd(12)} 分析返回 null —— 诊断: ${JSON.stringify(payload.diag)}`);
      console.log(`  完整 payload keys: ${Object.keys(payload).join(",")}`);
      continue;
    }
    // ⚠️ 防御：页面返回的对象可能缺字段（→ toFixed 崩在后面）
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    results.push({
      layer,
      centroid: num(a.centroid),
      lowPct: num(a.lowPct),
      midPct: num(a.midPct),
      highPct: num(a.highPct),
      rmsMean: num(a.rmsMean),
      rmsCv: num(a.rmsCv),
      peak: num(a.peak),
    });
    console.log(
      `${layer.padEnd(12)} ${num(a.centroid).toFixed(0).padStart(7)}Hz ` +
        `${num(a.lowPct).toFixed(1).padStart(6)} ${num(a.midPct).toFixed(1).padStart(7)} ` +
        `${num(a.highPct).toFixed(1).padStart(7)} ${num(a.rmsCv).toFixed(3).padStart(8)} ` +
        `${num(a.peak).toFixed(3).padStart(7)}`
    );

    // 试听用的 WAV（分块 base64 → Float32 → 16bit PCM）
    if (!target) {
      const parts = payload.chunks.map((c) => Buffer.from(c, "base64"));
      const totalBytes = parts.reduce((s, b) => s + b.length, 0);
      const all = new Float32Array(totalBytes / 4);
      let off = 0;
      for (const b of parts) {
        const view = new Float32Array(
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
        );
        all.set(view, off);
        off += view.length;
      }
      writeFileSync(`shots/audio/${layer}.wav`, encodeWav(all, 44100));
    }
  }

  console.log("");
  if (results.length) {
    const avg = (k) => results.reduce((s, r) => s + r[k], 0) / results.length;
    const c = avg("centroid");
    const low = avg("lowPct");
    const cv = avg("rmsCv");
    console.log(`平均频谱重心：${c.toFixed(0)}Hz  ${c < 2000 ? "✓ 柔和" : "✗ 偏尖锐刺耳"}`);
    console.log(`平均低频占比：${low.toFixed(1)}%  ${low > 8 ? "✓ 有低频基础" : "✗ 低频不足（声音薄）"}`);
    console.log(`平均 RMS 波动：${cv.toFixed(3)}  ${cv > 0.15 ? "✓ 有呼吸感" : "✗ 过于恒定（死板）"}`);
    console.log(`\nWAV 已导出到 shots/audio/（可试听）`);
  }
} catch (e) {
  console.error("渲染失败:", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
