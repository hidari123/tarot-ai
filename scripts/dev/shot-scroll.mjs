import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 滚动到指定位置再截图（看页面下半部分）
 * 用法：node scripts/dev/shot-scroll.mjs <url> <out.png> <scrollY> [w] [h]
 */
const url = process.argv[2] ?? "http://localhost:3001/";
const out = process.argv[3] ?? "shots/scroll.png";
const scrollY = Number(process.argv[4] ?? 600);
const W = Number(process.argv[5] ?? 414);
const H = Number(process.argv[6] ?? 896);

const PORT = 9700 + Math.floor(Math.random() * 25);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(), "scr-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--window-size=414,896", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); } send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error("timeout")); } }, 30000); }); } }
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {} await sleep(250); }
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = pages.find((p) => p.type === "page");
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  const c = new CDP(ws);
  await c.send("Runtime.enable"); await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: true });
  await c.send("Page.navigate", { url });
  await sleep(11000);
  await c.send("Runtime.evaluate", { expression: `scrollTo(0, ${scrollY})` });
  await sleep(1500);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const fs = await import("node:fs");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`✓ ${out} (scrollY=${scrollY}, ${W}x${H})`);
} catch (e) { console.error("ERR", e.message); } finally { chrome.kill(); }
