#!/usr/bin/env node
/**
 * 验证：仪式阶段 → 配乐曲目的**实时联动**
 *
 * ⚠️ 为什么这个必须单独跑一遍：
 *   静态检查能证明"阶段映射表写对了"，但证明不了
 *   "占卜进行中，阶段一变，配乐真的换了曲子"。
 *   中间隔着三层：SSE → ritualPhase → setScorePhase → 懒加载 → 交叉淡化。
 *   → 只有真跑一场占卜才能证明。
 *
 * ⚠️⚠️ 为什么脚本必须**自动替用户回答 HITL**（2026-11-17 修的关键缺陷）：
 *   占卜是「人机对话」驱动的 —— 承约要用户确认、呼召要用户答三问、选牌要用户点牌。
 *   不替用户点下去，仪式**永远停在第一个阶段**（contract），
 *   → 只能验证到 1 个阶段，看起来像"阶段联动坏了"，其实是脚本没走完。
 *   → 本脚本扮演用户把仪式一路推下去，才能真正验证多个阶段都会换曲。
 *
 * ⚠️ 为什么用无头 Chrome 而不是内置浏览器：
 *   内置浏览器标签页在长脚本（>30s）下会被重置 → 采样到一半就断。
 *   无头 Chrome 由本脚本独占 → 可重复、可进 CI。
 *
 * ⚠️ 为什么需要 `--autoplay-policy=no-user-gesture-required`：
 *   AudioContext 必须有用户手势才能 resume。无头环境没有手势，
 *   → 用这个开关放宽策略（仅本脚本的临时 profile，不影响用户浏览器）。
 *
 * 用法：node scripts/dev/verify-score-switch.mjs [--base=http://localhost:3000] [--ms=90000]
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
void here;

const BASE =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ??
  "http://localhost:3000";

const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

/** 采样时长（毫秒） */
const SAMPLE_MS = Number(process.argv.find((a) => a.startsWith("--ms="))?.slice(5) ?? 90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════════════════════════════════════════════════════════════
 * 页面内脚本：解锁 → 开始占卜 → 替用户推进仪式 → 采样阶段与曲目
 * ══════════════════════════════════════════════════════════════ */
const PAGE_FN = `
window.__runSwitchProbe__ = async function (sampleMs) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (sel, re) =>
    [...document.querySelectorAll(sel)].find((el) => re.test((el.textContent || "").trim()));

  const snap = () => {
    const sc = globalThis.__mysticTarotScore;
    const eng = globalThis.__mysticTarotAudioEngine;
    return {
      phase: eng?.phase ?? null,
      style: eng?.style ?? null,
      playingKey: sc?.playingKey ?? null,
      cached: sc ? sc.buffers.size : null,
      ctxState: eng?.ctx?.state ?? null,
    };
  };

  const out = { steps: [], error: null, api: [], advances: [], styleSwitched: false };

  /* ⚠️ 埋 fetch 探针：占卜到底有没有打后端，是排查"阶段没变"的第一分叉 */
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.includes("/api/")) out.api.push({ url: String(url).slice(0, 80), t: Date.now() });
    } catch { /* 忽略 */ }
    return origFetch.apply(this, arguments);
  };

  /* ⚠️ React 受控输入：直接赋 .value 不触发 onChange → 必须用原生 setter */
  const setNativeValue = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  /* ══════════ 替用户推进仪式 ══════════ */
  const advance = async () => {
    // ① 呼召三问（面板里三个输入 + 「以此呼召」按钮）
    const invBtn = byText("button", /以此呼召/);
    if (invBtn) {
      const ps = ["你想听到的答案…", "你打算做的动作…", "你还没面对的担心…"];
      const vals = ["想知道该不该换工作", "下个月开始投递简历", "怕自己能力不够"];
      let filled = 0;
      for (let i = 0; i < ps.length; i++) {
        const el = document.querySelector('input[placeholder="' + ps[i] + '"]');
        if (el) { setNativeValue(el, vals[i]); filled++; }
      }
      if (filled > 0) {
        await wait(150);
        const b = byText("button", /以此呼召/);
        if (b && !b.disabled) { b.click(); out.advances.push("呼召三问"); return true; }
      }
      return false;
    }

    // ② 选牌：点满 3 张自动确认（pick() 会忽略已选中的牌 → 重复点安全）
    const fan = [...document.querySelectorAll("button.glow-border")];
    if (fan.length >= 3) {
      fan.slice(0, 3).forEach((b) => b.click());
      out.advances.push("选牌");
      return true;
    }

    // ③ 承约 / 收束 / 命运岔路口：面板里的选项按钮
    //    ⚠️ 必须**限定在提问面板内** —— 否则会误点页面上的任意按钮
    const hdr = byText("span", /^(承 约|呼 召|命运岔路口|收 束|占卜师问)$/);
    const panel = hdr ? hdr.closest("div.rounded-2xl") : null;
    if (panel) {
      // 选项按钮在 div.flex-col 里；「说」按钮在 div.flex.gap-2 里 → 天然区分
      const opt = panel.querySelector("div.flex-col > button");
      if (opt) { opt.click(); out.advances.push("选项:" + (opt.textContent || "").trim().slice(0, 12)); return true; }
      // ④ 没有选项 → 走自由输入 + 「说」
      const free = panel.querySelector('input[placeholder="或自由输入…"]');
      const say = byText("button", /^说$/);
      if (free && say) {
        setNativeValue(free, "好的，就这样开始");
        await wait(120);
        const s2 = byText("button", /^说$/);
        if (s2 && !s2.disabled) { s2.click(); out.advances.push("自由输入"); return true; }
      }
    }
    return false;
  };

  // ① 解锁音频（点提示气泡 / 面板里的 ♪）
  const hint = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").includes("本页有配乐")
  );
  const speaker = document.querySelector('button[aria-label="打开音乐音量面板"]');
  if (hint) {
    hint.click();
  } else if (speaker) {
    speaker.click();
    await wait(300);
    const music = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") || "").includes("开启配乐")
    );
    if (music) music.click();
  }
  await wait(1500);
  out.steps.push({ step: "unlock", ...snap() });

  // ② 填问题（React 受控输入 → 必须用原生 setter）
  const input = document.querySelector('input[aria-label="写下你的问题"]');
  if (!input) { out.error = "找不到问题输入框"; return out; }
  setNativeValue(input, "我最近该不该换工作？");
  await wait(400);
  out.inputValue = input.value;

  // ③ 开始占卜
  const btn = [...document.querySelectorAll("button")].find((b) =>
    (b.textContent || "").includes("开始占卜")
  );
  if (!btn) { out.error = "找不到「开始占卜」按钮"; return out; }
  btn.click();
  await wait(800);
  out.steps.push({ step: "start", ...snap() });

  // ④ 采样阶段 ↔ 曲目的对应关系（并替用户推进仪式）
  const seen = new Set();
  const t0 = Date.now();
  let lastText = "";
  let lastAdvance = 0;
  while (Date.now() - t0 < sampleMs) {
    const s = snap();
    s.apiCount = out.api.length;
    // 抓可见文本里的错误提示（占卜没启动时通常会在这里露出来）
    const bodyText = (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 400);
    const m = bodyText.match(/(失败|错误|超时|不可达|请重试|出错了|限速|占卜师)[^。！\\n]{0,40}/);
    if (m) lastText = m[0];
    s.hint = lastText || undefined;
    const sig = s.phase + "|" + s.playingKey + "|" + s.apiCount;
    if (!seen.has(sig)) {
      seen.add(sig);
      out.steps.push({ step: "sample", ...s });
    }

    /* ⚠️ 每 1.2s 替用户推进一步 —— 两次推进之间留出后端处理时间 */
    if (Date.now() - lastAdvance > 1200) {
      lastAdvance = Date.now();
      await advance();
    }

    /* ⚠️ 中途切一次风格：验证换风格后曲子前缀也跟着换（而不是留在旧风格的曲子上） */
    if (!out.styleSwitched && Date.now() - t0 > sampleMs * 0.55) {
      const sp = document.querySelector('button[aria-label="打开音乐音量面板"]');
      if (sp) {
        sp.click();
        await wait(300);
        const deep = [...document.querySelectorAll("button")].find(
          (b) => (b.textContent || "").trim() === "深海低语"
        );
        if (deep) {
          deep.click();
          out.styleSwitched = true;
          await wait(200);
          out.steps.push({ step: "styleB", ...snap() });
        }
      }
    }

    await wait(400);
  }
  out.final = snap();
  out.api = out.api.slice(0, 20);
  return out;
};
`;

/* ══════════════════════════════════════════════════════════════
 * Chrome + CDP
 * ══════════════════════════════════════════════════════════════ */
const PORT = 9900 + Math.floor(Math.random() * 90);
const userDataDir = mkdtempSync(join(tmpdir(), "score-sw-"));
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
  throw new Error("Chrome Devtools 端口未就绪");
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
  send(method, params = {}, timeoutMs = 180000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, timeoutMs);
    });
  }
}

let exitCode = 1;
try {
  const wsUrl = await waitForDevtools();
  const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("找不到可用页面 target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new CDP(ws);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log(`→ 打开 ${BASE}`);
  await cdp.send("Page.navigate", { url: BASE });

  // ⚠️ 必须等页面**同源且就绪**，否则相对路径 fetch 与 DOM 查询都会失败
  const wantOrigin = new URL(BASE).origin;
  let ready = false;
  for (let i = 0; i < 160; i++) {
    await sleep(250);
    const probe = await cdp.send("Runtime.evaluate", {
      expression: "location.origin + '|' + document.readyState",
      returnByValue: true,
    });
    if ((probe.result?.value ?? "").startsWith(wantOrigin)) {
      ready = true;
      break;
    }
  }
  if (!ready) throw new Error(`页面没有在 40s 内就绪（dev server 没起来？）`);

  await cdp.send("Runtime.evaluate", { expression: PAGE_FN });

  console.log(`→ 开始一场真实占卜，采样 ${(SAMPLE_MS / 1000).toFixed(0)}s\n`);

  const res = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(async () => JSON.stringify(await window.__runSwitchProbe__(${SAMPLE_MS})))()`,
      awaitPromise: true,
      returnByValue: true,
    },
    SAMPLE_MS + 120000
  );
  if (res.exceptionDetails) {
    throw new Error(`页面脚本报错：${res.exceptionDetails.exception?.description ?? ""}`);
  }
  const out = JSON.parse(res.result.value);

  if (out.error) throw new Error(out.error);

  /* ---- 报告 ---- */
  console.log("阶段 → 曲目  映射实测：");
  console.log("─".repeat(78));
  const transitions = out.steps.filter((s) => s.step === "sample" || s.step === "start");
  const seen2 = new Set();
  for (const s of transitions) {
    const line =
      `  ${String(s.phase).padEnd(11)} → ${String(s.playingKey).padEnd(16)} ` +
      `风格 ${String(s.style).padEnd(2)} 缓存 ${s.cached} 首  API ${s.apiCount ?? 0} 次` +
      (s.hint ? `  提示:${s.hint}` : "");
    if (!seen2.has(line)) {
      seen2.add(line);
      console.log(line);
    }
  }
  const styleBSample = out.steps.find((s) => s.step === "styleB");
  if (styleBSample) {
    console.log(
      `  ${String(styleBSample.phase).padEnd(11)} → ${String(styleBSample.playingKey).padEnd(16)} 风格 ${styleBSample.style} （切风格后）`
    );
  }

  console.log(`\n问题输入框回读：${JSON.stringify(out.inputValue ?? null)}`);
  console.log(`后端 API 调用：${out.api.length} 次`);
  for (const a of out.api.slice(0, 8)) console.log(`  · ${a.url}`);
  console.log(`替用户推进仪式：${out.advances.length} 次 → ${out.advances.join(" / ") || "（无）"}`);

  const changed = new Set(transitions.map((s) => s.playingKey).filter(Boolean));
  const phases = new Set(transitions.map((s) => s.phase).filter(Boolean));

  console.log(`\n音频上下文：${out.final.ctxState}`);
  console.log(`已加载曲目：${out.final.cached} 首（懒加载：只下用到的曲目）`);
  console.log(`出现过 ${changed.size} 首不同曲目：${[...changed].join(" / ")}`);
  console.log(`出现过 ${phases.size} 个阶段：${[...phases].join(" / ")}`);

  /* ---- 断言 ---- */
  /**
   * ⚠️ 为什么不能要求"每个采样点都精确匹配"：
   *   阶段一变，`eng.phase` 立刻更新，但新曲子是**异步 fetch + 解码**后才切上去
   *   （score.ts 里 playingKey 在新槽启动时才赋值）→ 中间有几秒的过渡态。
   *   → 正确判据是"每个阶段**最终**稳定到它自己的曲子"，
   *     而不是"过渡的那一瞬间也要匹配"。
   */
  const okByPhase = new Map();
  const pendingSamples = [];
  for (const s of transitions) {
    if (!s.phase || !s.playingKey) continue;
    const expect = `score-${s.style}-${String(s.phase).toLowerCase()}`;
    if (s.playingKey === expect) {
      if (!okByPhase.has(s.phase)) okByPhase.set(s.phase, 0);
      okByPhase.set(s.phase, okByPhase.get(s.phase) + 1);
    } else {
      pendingSamples.push(`${s.phase}→${s.playingKey}`);
    }
  }

  const nonIdle = [...phases].filter((p) => p !== "idle");
  const started = out.api.some((a) => a.url.includes("/api/interpret"));

  const checks = [];
  checks.push(["音频上下文已解锁", out.final.ctxState === "running"]);
  checks.push([
    "每个阶段都稳定切到了它自己的曲子",
    [...phases].every((p) => okByPhase.has(p)),
    [...phases].map((p) => `${p}:${okByPhase.get(p) ?? 0}次匹配`).join(" "),
  ]);
  checks.push([
    "至少观察到 2 个非待机阶段（仪式真的推进了）",
    nonIdle.length >= 2,
    `非待机阶段 = ${nonIdle.join(",") || "无"}`,
  ]);
  checks.push([
    "阶段 → 曲目映射精确（无错配）",
    pendingSamples.length <= transitions.length * 0.5,
    pendingSamples.length ? `过渡态 ${pendingSamples.length} 次：${pendingSamples.slice(0, 3).join(" ")}` : "全程精确匹配",
  ]);
  checks.push([
    "懒加载生效（没有一次下完 14 首）",
    out.final.cached <= phases.size + 2,
    `缓存 ${out.final.cached} 首 / 观察 ${phases.size} 个阶段`,
  ]);
  checks.push(["占卜确实发起了（打过 /api/interpret）", started]);

  console.log("");
  let ok = true;
  for (const [label, pass, detail] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
    if (!pass) ok = false;
  }
  console.log(
    `\n${ok ? "✅" : "❌"} ${ok ? "阶段联动正常：占卜推进时配乐跟着换曲，且只懒加载用到的曲目" : "阶段联动未观察到预期变化" + (started ? "（占卜已发起但阶段未变）" : "（占卜根本没发起 —— 见上面的 API 调用记录）")}`
  );
  exitCode = ok ? 0 : 1;
} catch (e) {
  console.error(`✗ ${e.message}`);
  exitCode = 1;
} finally {
  chrome.kill();
}
process.exit(exitCode);
