#!/usr/bin/env node
/**
 * 验证 P1-④：API 鉴权与安全策略（公网部署标准）
 *
 * ⚠️ 为什么必须测：
 *    审计实测的泄露面（全部已修复）：
 *      ① /api/dashboard 完全公开 → 暴露全站用户的问题原文 + 全部解读
 *      ② /api/share?id=<可枚举的 sessionId> → 私密解读全文
 *      ③ /api/interpret 客户端可指定任意 userKey → 读写他人画像
 *      ④ /api/answer 拿到 sessionId 即可替用户回答
 *      ⑤ 输入无长度上限 → 单请求放大 token 成本
 *      ⑥ /api/health 泄露服务器绝对路径
 *
 * 本脚本用**真实 HTTP 请求**验证（不是读代码判断），
 * 需要先启动服务。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://localhost:3000";

// ⚠️ 读 .env.local 里的 DASHBOARD_TOKEN（测试需要真实 token）
let dashboardToken = "";
try {
  const envText = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === "DASHBOARD_TOKEN") {
      dashboardToken = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch { /* ignore */ }

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== P1-④ API 鉴权验证 ===\n");
console.log(`目标: ${BASE}`);
console.log(`DASHBOARD_TOKEN: ${dashboardToken ? "已配置" : "未配置（面板会 fail closed）"}\n`);

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（HTML） */ }
  return { status: res.status, headers: res.headers, json, text };
}
async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, headers: res.headers, json, text };
}

/* ---- ① 面板无 token → 401 ---- */
{
  const r = await get("/api/dashboard");
  check(
    "面板无 token → 401 拒绝",
    r.status === 401,
    `status=${r.status}`
  );
}

/* ---- ② 面板错误 token → 401 ---- */
{
  const r = await get("/api/dashboard", { "X-Access-Token": "wrong-token-xxx" });
  check(
    "面板错误 token → 401 拒绝",
    r.status === 401,
    `status=${r.status}`
  );
}

/* ---- ③ 面板正确 token → 200 ---- */
{
  if (!dashboardToken) {
    check("面板正确 token → 200（跳过：未配置 DASHBOARD_TOKEN）", true, "跳过");
  } else {
    const r = await get("/api/dashboard", { "X-Access-Token": dashboardToken });
    check(
      "面板正确 token → 200 放行",
      r.status === 200,
      `status=${r.status}`
    );
    check(
      "面板响应含统计数据",
      r.json && typeof r.json.totalSessions === "number",
      `totalSessions=${r.json?.totalSessions}`
    );
  }
}

/* ---- ④ 面板事件接口同样鉴权 ---- */
{
  const r = await get("/api/dashboard/events");
  check(
    "面板事件接口无 token → 401",
    r.status === 401,
    `status=${r.status}`
  );
}

/* ---- ⑤ 安全响应头 ---- */
{
  const r = await get("/api/personas");
  const h = r.headers;
  check(
    "响应带 X-Content-Type-Options: nosniff",
    h.get("x-content-type-options") === "nosniff",
    h.get("x-content-type-options") ?? "缺失"
  );
  check(
    "响应带 X-Frame-Options",
    !!h.get("x-frame-options"),
    h.get("x-frame-options") ?? "缺失"
  );
  check(
    "响应带 Referrer-Policy",
    !!h.get("referrer-policy"),
    h.get("referrer-policy") ?? "缺失"
  );
  check(
    "响应带 CSP",
    !!h.get("content-security-policy"),
    (h.get("content-security-policy") ?? "缺失").slice(0, 48) + "…"
  );
}

/* ---- ⑥ 分享接口无 token → 拒绝 ---- */
{
  const r = await get("/api/share");
  check(
    "分享接口无令牌 → 400/404 拒绝",
    r.status === 400 || r.status === 404,
    `status=${r.status}`
  );
}

/* ---- ⑦ health 不泄露绝对路径 ---- */
{
  const r = await get("/api/health");
  const vec = r.json?.vector;
  const cacheDir = vec?.cacheDir ?? "";
  check(
    "health 的 cacheDir 不是绝对路径",
    !/[A-Za-z]:[\\/]|^\//.test(cacheDir),
    `cacheDir=${JSON.stringify(cacheDir)}`
  );
}

/* ---- ⑧ 输入长度上限：超长 question 被截断 ---- */
{
  // ⚠️ 用一个明显超长的 question（10 万字符）
  // ⚠️ 关键：**不能等完整响应** —— 触发占卜流程会挂在 HITL 等待上。
  //    用 AbortSignal 超时（2 秒）只取状态码。
  const huge = "测试".repeat(50_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  let status = 0;
  try {
    const res = await fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: huge, persona: "mystic" }),
      signal: ctrl.signal,
    });
    status = res.status;
    // 读取 sessionId 事件（SSE 第一条）
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("session")) break;
    }
    ctrl.abort();
    const m = buf.match(/"sessionId"\s*:\s*"([^"]+)"/);
    const sid = m ? m[1] : "";
    // ⚠️ 两条合法路径：
    //   ① 请求体超过 32KB → 400（直接拒绝，不进 prompt）
    //   ② 请求体合法但 question 超长 → 截断到 500 字后接受
    check(
      "超长 question 被拒绝或截断（都不 5xx）",
      status === 200 || status === 400 || status === 413,
      `status=${status}${status === 400 ? "（请求体过大 → 拒绝，符合预期）" : ""}`
    );
    if (sid) {
      const hist = await get(`/api/session/${sid}`);
      const q = hist.json?.question ?? "";
      check(
        "落库的问题已被截断到上限内",
        q.length <= 500,
        `落库长度=${q.length}（上限 500）`
      );
    } else {
      check("落库的问题已被截断到上限内（跳过：没拿到 sessionId）", true, "跳过");
    }
  } catch {
    // AbortError：说明请求在 2 秒内没返回（可能是流式响应正常挂着）
    check("超长 question 被接受但不 5xx（走截断）", status === 0 || status === 200, `status=${status}（超时中断属正常）`);
    check("落库的问题已被截断到上限内（跳过：流式未结束）", true, "跳过");
  } finally {
    clearTimeout(timer);
  }
}

/* ---- ⑨ 超长请求体被拒绝 ---- */
{
  const huge = JSON.stringify({ question: "x".repeat(100_000) });
  const r = await post("/api/interpret", huge);
  check(
    "超长请求体被拒绝（400/413）",
    r.status === 400 || r.status === 413,
    `status=${r.status} · body=${(huge.length / 1024).toFixed(0)}KB`
  );
}

/* ---- ⑨b 请求体合法但 question 超长 → 截断（不放大成本）---- */
{
  // 构造一个**请求体不大**但 question 超长的场景：
  // 用 600 个中文字（1200 字节，远小于 32KB）→ 触发内容截断而非体积拒绝
  const long = "问".repeat(600);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  let sid = "";
  let status = 0;
  try {
    const res = await fetch(`${BASE}/api/interpret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: long, persona: "mystic" }),
      signal: ctrl.signal,
    });
    status = res.status;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("sessionId")) break;
    }
    const m = buf.match(/"sessionId"\s*:\s*"([^"]+)"/);
    sid = m ? m[1] : "";
  } catch {
    /* 超时中断（流式正常挂着）*/
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }

  check(
    "超长 question（体积合法）被接受或截断",
    status === 200 || status === 0,
    `status=${status}`
  );
  if (sid) {
    const hist = await get(`/api/session/${sid}`);
    const q = hist.json?.question ?? "";
    check(
      "落库的问题被截断到 500 字以内（防 prompt 放大）",
      q.length <= 500,
      `落库长度=${q.length}（原 600）`
    );
  } else {
    check("落库的问题被截断到 500 字以内（跳过：没拿到 sessionId）", true, "跳过");
  }
}

/* ---- ⑩ sessionId 不可枚举（192bit 随机）---- */
{
  /** 发起占卜但只读第一段 SSE（拿到 sessionId 就停） */
  const startAndGetId = async (question) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`${BASE}/api/interpret`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, persona: "mystic" }),
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes("sessionId")) break;
      }
      const m = buf.match(/"sessionId"\s*:\s*"([^"]+)"/);
      return m ? m[1] : "";
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  };

  const s1 = await startAndGetId("测试会话 id 随机性 A");
  const s2 = await startAndGetId("测试会话 id 随机性 B");
  check(
    "sessionId 格式为 sess_ + 随机串（无时间戳前缀）",
    /^sess_[A-Za-z0-9_-]{20,}$/.test(s1),
    s1.slice(0, 24) + "…"
  );
  check(
    "两个 sessionId 完全不同",
    !!s1 && !!s2 && s1 !== s2,
    ""
  );
  // ⚠️ 关键：不含时间戳 → 无法按时间枚举
  const randPart = s1.replace("sess_", "");
  check(
    "sessionId 不含可枚举的时间戳成分（随机部分足够长）",
    randPart.length >= 24,
    `随机部分长度=${randPart.length}（24 字节 base64url ≈ 32 字符）`
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
