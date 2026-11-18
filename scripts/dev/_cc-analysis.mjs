import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 量化分析：小女孩 vs 背景的对比度
 * ⚠️ 采样：人物脸部区域 / 人物头发暗部 / 背景同位置
 */
const url = process.argv[2] ?? "http://localhost:3001/";
const PORT = 9950 + Math.floor(Math.random() * 20);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(), "cc-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error("timeout")); } }, 40000); }); }
}
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {} await sleep(250); }
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = pages.find((p) => p.type === "page");
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  const c = new CDP(ws);
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url });
  await sleep(12000);

  // 取两个图层的实际像素（用 canvas 画到 offscreen 读像素太慢）
  // → 改用截图 + 局部亮度采样（用 sharp 在 node 侧做）
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  const buf = Buffer.from(shot.data, "base64");
  writeFileSync("shots/_cc.png", buf);
  console.log("✓ shots/_cc.png");

  // 顺便报各层的 opacity / filter
  const info = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const imgs = [...document.querySelectorAll('img')];
      const rows = imgs.filter(i => i.src.includes('orb-witch')).map(i => ({
        src: i.src.slice(-20),
        opacity: getComputedStyle(i).opacity,
        filter: getComputedStyle(i).filter,
        mix: getComputedStyle(i).mixBlendMode,
        rect: (r => Math.round(r.x)+','+Math.round(r.y)+' '+Math.round(r.width)+'x'+Math.round(r.height))(i.getBoundingClientRect()),
      }));
      return JSON.stringify(rows, null, 1);
    })()`,
    returnByValue: true,
  });
  console.log(info.result?.value);
} catch (e) { console.error("ERR", e.message); } finally { chrome.kill(); }
