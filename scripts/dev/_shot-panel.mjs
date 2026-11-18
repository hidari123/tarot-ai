import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 用**真实鼠标事件**点击（CDP Input.dispatchMouseEvent）
 * ⚠️ 原因：programmatic click() 不是用户手势 → AudioContext.resume() 挂起 → 静音状态不变
 */
const url = process.argv[2] ?? "http://localhost:3001/";
const out = process.argv[3] ?? "shots/panel.png";
const PORT = 9920 + Math.floor(Math.random() * 20);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(), "pm-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--autoplay-policy=no-user-gesture-required", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
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
  await sleep(13000);

  /** 找按钮坐标 */
  const pos = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const b = document.querySelector('.fixed.right-4.top-4 button');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), label: b.getAttribute('aria-label') };
    })()`,
    returnByValue: true,
  });
  const p = pos.result?.value;
  console.log("按钮:", JSON.stringify(p));
  if (!p) throw new Error("找不到按钮");

  /** 真实鼠标点击 */
  const mouseClick = async (x, y) => {
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(60);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };

  console.log("→ 第 1 次点击（开声音）");
  await mouseClick(p.x, p.y);
  await sleep(1800);

  const after1 = await c.send("Runtime.evaluate", {
    expression: `document.querySelector('.fixed.right-4.top-4 button')?.getAttribute('aria-label')`,
    returnByValue: true,
  });
  console.log("  标签:", after1.result?.value);

  console.log("→ 第 2 次点击（开面板）");
  await mouseClick(p.x, p.y);
  await sleep(1200);

  const state = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const panel = document.querySelector('.fixed.right-4.top-4 .absolute');
      const btn = document.querySelector('.fixed.right-4.top-4 button');
      return JSON.stringify({
        label: btn?.getAttribute('aria-label'),
        hasPanel: !!panel,
        panelText: panel?.textContent?.slice(0, 80) ?? null,
      });
    })()`,
    returnByValue: true,
  });
  console.log("  状态:", state.result?.value);

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`✓ ${out}`);
} catch (e) { console.error("ERR", e.message); } finally { chrome.kill(); }
