import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 用**持久化 profile** 截图（模拟真实浏览器的缓存/SW 环境）
 * ⚠️ 为什么不用临时 profile：
 *   · 临时 profile = 全新环境 → 第一次访问没有 SW → 看不到缓存问题
 *   · 持久化 profile = 保留上次的 SW 和缓存 → 才能复现"用户看到的旧版本"
 *
 * 用法：node scripts/dev/shot-persist.mjs <url> <out.png> [waitMs] [w] [h] [--fresh]
 */
const url = process.argv[2] ?? "http://localhost:3000/";
const out = process.argv[3] ?? "shots/persist.png";
const waitMs = Number(process.argv[4] ?? 10000);
const W = Number(process.argv[5] ?? 1200);
const H = Number(process.argv[6] ?? 900);
const FRESH = process.argv.includes("--fresh");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
/** ⚠️ 持久化 profile 目录（跨次保留 SW 和缓存） */
const PROFILE = "D:\\Hidari\\study\\tarot-ai\\.chrome-profile";

if (FRESH && existsSync(PROFILE)) {
  rmSync(PROFILE, { recursive: true, force: true });
  console.log("✓ 已清空持久化 profile（首次访问，无 SW）");
}

const PORT = 9400 + Math.floor(Math.random() * 90);
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--window-size=${W},${H}`, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.p = new Map();
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.p.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error(method + " timeout")); } }, 40000);
    });
  }
}

try {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(250);
  }
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = pages.find((p) => p.type === "page");
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const c = new CDP(ws);
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  /* ⚠️ 第一遍：访问页面（可能安装 SW） */
  await c.send("Page.navigate", { url });
  await sleep(waitMs);

  /* 检查 SW 状态 */
  const swInfo = await c.send("Runtime.evaluate", {
    expression: `(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const keys = await caches.keys();
      return JSON.stringify({
        swCount: regs.length,
        swScope: regs.map(r => r.scope),
        swState: regs.map(r => r.active?.scriptURL),
        caches: keys,
      });
    })()`,
    awaitPromise: true, returnByValue: true,
  });
  console.log("SW 状态:", swInfo.result?.value);

  /* 第二遍：重新导航（模拟用户刷新页面） */
  await c.send("Page.navigate", { url });
  await sleep(3000);

  /* 截图 */
  const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const fs = await import("node:fs");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`✓ ${out}  (${W}x${H})  ← 持久化 profile，含真实 SW/缓存`);

  /* 顺便报告关键元素位置，便于对比 */
  const info = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const img = document.querySelector('img[src*="orb-witch"]');
      const r = img?.getBoundingClientRect();
      return JSON.stringify({
        imgRect: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        imgs: document.querySelectorAll('img[src*="orb-witch"]').length,
      });
    })()`, returnByValue: true,
  });
  console.log("页面:", info.result?.value);
} catch (e) {
  console.error("ERR:", e.message);
} finally {
  chrome.kill();
}
