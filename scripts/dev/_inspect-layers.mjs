import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 检查页面各层的实际 z-index / DOM 顺序
 */
const url = process.argv[2] ?? "http://localhost:3001/";
const PORT = 9940 + Math.floor(Math.random() * 20);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(), "lay-"));
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

  const r = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const rows = [];
      const walk = (el, depth, path) => {
        if (depth > 4) return;
        for (const ch of el.children) {
          const cs = getComputedStyle(ch);
          const img = ch.tagName === 'IMG' ? ch.getAttribute('src') : '';
          const isCircle = img.includes('magic-circle');
          const isOrb = ch.tagName === 'IMG' && img.includes('orb-witch');
          if (isCircle || isOrb || (cs.position === 'absolute' && cs.zIndex !== 'auto')) {
            const b = ch.getBoundingClientRect();
            rows.push({
              path: path + '>' + ch.tagName + (ch.className ? '.' + String(ch.className).split(' ').slice(0,3).join('.') : ''),
              pos: cs.position,
              z: cs.zIndex,
              blend: cs.mixBlendMode,
              opacity: cs.opacity,
              filter: cs.filter.slice(0, 60),
              rect: Math.round(b.x)+','+Math.round(b.y)+' '+Math.round(b.width)+'x'+Math.round(b.height),
              img: img.slice(-28),
            });
          }
          walk(ch, depth + 1, path + '>' + ch.tagName);
        }
      };
      walk(document.body, 0, 'body');
      return JSON.stringify(rows, null, 1);
    })()`,
    returnByValue: true,
  });
  console.log(r.result?.value);
} catch (e) { console.error("ERR", e.message); } finally { chrome.kill(); }
