import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ⚠️ 截取占卜页（stage !== "input"）的样子
 * ⚠️ 用法：node scripts/dev/_shot-reading.mjs <out.png> [scrollY]
 */
const out = process.argv[2] ?? "shots/reading.png";
const scrollY = Number(process.argv[3] ?? 0);
const PORT = 9980 + Math.floor(Math.random() * 20);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(), "rd-"));
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
  await c.send("Page.navigate", { url: "http://localhost:3001/" });
  await sleep(13000);

  // 点「开始占卜」进入占卜阶段
  await c.send("Runtime.evaluate", {
    expression: `(() => {
      const inp = document.querySelector('input[aria-label="写下你的问题"]');
      if (!inp) return 'no-input';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '我最近工作很不顺，想问该怎么办');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`,
  });
  await sleep(800);
  await c.send("Runtime.evaluate", {
    expression: `(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始占卜'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    })()`,
  });
  await sleep(9000);

  if (scrollY) {
    await c.send("Runtime.evaluate", { expression: `window.scrollTo(0, ${scrollY});` });
    await sleep(1200);
  }

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`✓ ${out}`);

  const state = await c.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      h: document.documentElement.scrollHeight,
      hasAsk: !!document.querySelector('[class*="rounded-2xl"]'),
      texts: [...document.querySelectorAll('p')].map(p=>p.textContent.slice(0,30)).filter(t=>t.length>3).slice(0,12),
    })`,
    returnByValue: true,
  });
  console.log(state.result?.value);
} catch (e) { console.error("ERR", e.message); } finally { chrome.kill(); }
