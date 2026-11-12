#!/usr/bin/env node
/**
 * 视觉回归截图（2026-11-05 视觉重设计）
 *
 * ⚠️⚠️ 为什么不能用 `chrome --headless --screenshot --virtual-time-budget=N`：
 *   我们的页面有**无限动画**（魔法阵旋转 80~140s、球体公转 26s、光晕呼吸…）。
 *   virtual-time-budget 会**快进虚拟时间**，导致：
 *     · 无限动画永不"结束" → 截图时机随机（有时截到动画中途的半透明状态）
 *     · framer-motion 的入场动画（opacity 0→1）被跳过 → 截到 opacity:0 的页面
 *   实测：同一页面连续截图，结果差异巨大（有内容/没内容）。
 *
 * ⚠️ 解法：**CDP + 真实等待**。
 *   启动 Chrome（带 --remote-debugging-port）→ 用 CDP 连接 →
 *   Page.navigate → 真实等待 N 秒（动画跑完）→ Page.captureScreenshot。
 *   → 截图反映真实用户看到的样子。
 *
 * 用法：node scripts/dev/shot.mjs <path> <out.png> [waitMs] [width] [height]
 *   例：node scripts/dev/shot.mjs / shots/home.png 6000 1440 1000
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , pathArg = "/", outArg = "shots/out.png", waitMs = "6000", w = "1440", h = "1000"] =
  process.argv;

const PORT = 9333 + Math.floor(Math.random() * 200);
const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const userDataDir = mkdtempSync(join(tmpdir(), "shot-"));

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${w},${h}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等 Chrome 的调试端口就绪 */
async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
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

/** 极简 CDP 客户端（WebSocket） */
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
      }, 30000);
    });
  }
}

try {
  const wsUrl = await waitForDevtools();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new CDP(ws);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  // 带 sessionId 的发送
  const send = (method, params = {}) => {
    const id = ++cdp.id;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      cdp.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (cdp.pending.has(id)) {
          cdp.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  };

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: Number(w),
    height: Number(h),
    deviceScaleFactor: 1,
    mobile: false,
  });

  const url = pathArg.startsWith("http") ? pathArg : `http://localhost:3000${pathArg}`;
  await send("Page.navigate", { url });
  // ⚠️ 真实等待（不是虚拟时间）—— 让动画与数据都跑完
  await sleep(Number(waitMs));

  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(outArg, Buffer.from(data, "base64"));
  console.log(`✓ ${outArg}  (${url}, 等待 ${waitMs}ms)`);
} catch (e) {
  console.error("截图失败:", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
}
