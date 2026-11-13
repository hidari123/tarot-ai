import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 测量首页的留白分布（找"哪里空"）
 */
const PORT = 9700 + Math.floor(Math.random() * 25);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(), "home-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: "http://localhost:3001/" });
  await sleep(12000);
  const r = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const q = (s) => document.querySelector(s);
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), b: Math.round(r.bottom) }; };
      const h1 = q('h1');
      const sub = [...document.querySelectorAll('p')].find(p => p.textContent.includes('倾听星辰'));
      const slot = q('[data-orb-slot]');
      const orb = q('img[src*="orb-witch"]');
      const cards = q('a[href="/daily"]');
      const orbs = [...document.querySelectorAll('p')].find(p => p.textContent.includes('选择你的占卜师'));
      const modeBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('快速一问'));
      const input = q('input[aria-label="写下你的问题"]');
      const startBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始占卜'));
      const main = q('main');
      return JSON.stringify({
        viewport: window.innerHeight,
        mainH: main && Math.round(main.getBoundingClientRect().height),
        docH: document.documentElement.scrollHeight,
        标题: rect(h1),
        副标题: rect(sub),
        球的占位: rect(slot),
        小女孩图: rect(orb),
        入口卡片: rect(cards),
        占卜师标题: rect(orbs),
        模式按钮: rect(modeBtn),
        输入框: rect(input),
        开始按钮: rect(startBtn),
      }, null, 1);
    })()`, returnByValue: true,
  });
  console.log(r.result?.value ?? JSON.stringify(r));
} catch (e) { console.error("ERR", e.message); } finally { chrome.kill(); }
