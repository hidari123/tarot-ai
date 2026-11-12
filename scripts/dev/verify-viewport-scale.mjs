import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 验证「不同视口下 构图比例一致」
 * ⚠️ 对比多个尺寸下：球心相对副标题的偏移、球直径、标题字号
 * ⚠️ 期望：偏移与球径的**比例**在各尺寸下相同
 */
const PORT = 9620 + Math.floor(Math.random() * 30);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(), "vp-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class CDP { constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { const { resolve, reject } = this.p.get(m.id); this.p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); } send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => { this.p.set(id, { resolve: res, reject: rej }); setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error("timeout")); } }, 40000); }); } }

const SIZES = [
  [1920, 1080], [1600, 900], [1440, 900], [1280, 800],
  [1200, 900], [1024, 768], [900, 700], [768, 1024], [414, 896],
];

try {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {} await sleep(250); }
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = pages.find((p) => p.type === "page");
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  const c = new CDP(ws);
  await c.send("Runtime.enable"); await c.send("Page.enable");

  const rows = [];
  for (const [w, h] of SIZES) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
    await c.send("Page.navigate", { url: "http://localhost:3001/" });
    await sleep(4500);
    const r = await c.send("Runtime.evaluate", {
      expression: `(() => {
        const h1 = document.querySelector('h1');
        const sub = [...document.querySelectorAll('p')].find(p => p.textContent.includes('倾听星辰'));
        const img = document.querySelector('img[src*="orb-witch"]');
        if (!h1 || !sub || !img) return JSON.stringify({ err: 'missing' });
        const hr = h1.getBoundingClientRect();
        const sr = sub.getBoundingClientRect();
        const ir = img.getBoundingClientRect();
        const u = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--u')) || 1;
        // 球心 = 图里 (503,595) 的位置
        const S = ir.height;
        const ballX = ir.x + (ir.width - S)/2 + 503/1024*S;
        const ballY = ir.y + 595/1024*S;
        const ballD = 186/1024*S;
        return JSON.stringify({
          u,
          font: Math.round(parseFloat(getComputedStyle(h1).fontSize)),
          subBottom: Math.round(sr.bottom),
          ballY: Math.round(ballY),
          ballD: Math.round(ballD),
          gap: Math.round(ballY - sr.bottom),
          imgY: Math.round(ir.y), imgW: Math.round(ir.width),
        });
      })()`, returnByValue: true,
    });
    let v; try { v = JSON.parse(r.result?.value ?? "{}"); } catch { v = { err: "parse" }; }
    rows.push({ size: `${w}x${h}`, ...v });
  }

  console.log("尺寸        u      标题字号  副标题底  球心Y   球径   球-副标题  图Y   图宽");
  for (const r of rows) {
    console.log(
      `${r.size.padEnd(11)} ${String(r.u ?? "-").padEnd(6)} ${String(r.font ?? "-").padStart(6)}  ${String(r.subBottom ?? "-").padStart(7)}  ${String(r.ballY ?? "-").padStart(5)}  ${String(r.ballD ?? "-").padStart(4)}  ${String(r.gap ?? "-").padStart(8)}  ${String(r.imgY ?? "-").padStart(4)}  ${String(r.imgW ?? "-").padStart(4)}`
    );
  }
  console.log("\n=== 归一化检查（除以球径，理想值应相同）===");
  for (const r of rows) {
    if (!r.ballD) continue;
    console.log(`${r.size.padEnd(11)} gap/球径 = ${(r.gap / r.ballD).toFixed(3)}   球心/图宽 = ${(r.ballY / r.imgW).toFixed(3)}`);
  }
} catch (e) { console.error("ERR", e.message); } finally { chrome.kill(); }
