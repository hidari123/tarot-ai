#!/usr/bin/env node
/**
 * 测量 supervisor 决策的真实耗时构成（P2-⑫ 的决策依据）
 *
 * ⚠️ 结论（2026-11-03 实测，glm-5.3 内网网关）：
 *
 *   ┌─────────────┬──────────────────┬────────────────────────┐
 *   │             │ 非流式           │ 流式                   │
 *   ├─────────────┼──────────────────┼────────────────────────┤
 *   │ 总耗时      │ 5370ms           │ 3925ms                │
 *   │ reasoning   │ 2787 字 ✅       │ 0 字 ❌（网关不下发）  │
 *   │ content     │ 203 字           │ —                     │
 *   │ tool_calls  │ 完整返回         │ 分片到达（要拼完才可用）│
 *   └─────────────┴──────────────────┴────────────────────────┘
 *
 *   ⚠️ 关键发现：**glm 网关在流式下完全不下发 reasoning_content**
 *      （也试过 thinking:{type:"enabled"}，同样没有）。
 *      而流式唯一的"提前量"是 tool_calls 的 arguments 分片 ——
 *      但 arguments 是 JSON，**必须拼完才能解析**，
 *      所以用户在流式下依然看不到任何"决策过程"。
 *
 *   → **流式化对 supervisor 的实际收益 ≈ 0**：
 *      省下的只是"完整响应 vs 分片到达"的零点几秒，
 *      而决策内容本身必须等完整。
 *      代价是"流式 tool_calls arguments 分片拼装"的复杂度与协议风险。
 *
 *   → **决定：不做 supervisor 流式化**（P2-⑫ 取消）。
 *      思考链通过非流式的 reasoning_content 一次性获取并立即推给前端
 *      （supervisor.ts 里 `if (decision.reasoning) yield {type:"reasoning"}`），
 *      用户已经能看到占卜师在想什么 —— 这部分价值已经拿到了。
 *
 *   ⚠️ 这个脚本保留下来，是为了防止后人重复做这个评估
 *      （"把决策也改成流式"听起来很美，但数据不支持）。
 *
 * 用法：npx tsx scripts/measure-supervisor-latency.mjs
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ Node 不自动加载 .env —— 手动解析 .env.local（Next.js 才有那套机制）
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envText = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch { /* 没有 .env.local 就算了 */ }

const key = process.env.DEEPSEEK_API_KEY;
const base = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const model = process.env.OPENAI_MODEL || "deepseek-chat";
if (!key) {
  console.log("⚠️ 未配置 DEEPSEEK_API_KEY，跳过实测");
  process.exit(0);
}

const messages = [
  { role: "system", content: "你是塔罗占卜师，思考后必须调用工具。" },
  { role: "user", content: "我最近工作压力很大，该怎么办？" },
];
const tools = [{
  type: "function",
  function: {
    name: "establish_contract",
    description: "承约：复述问题请用户确认",
    parameters: {
      type: "object",
      properties: { question: { type: "string" }, scope: { type: "string" } },
      required: ["question"],
    },
  },
}];

/* ---- ① 非流式：测完整响应耗时 ---- */
async function timeNonStream() {
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools, stream: false }),
  });
  const json = await res.json();
  const total = Date.now() - t0;
  const msg = json.choices?.[0]?.message ?? {};
  return {
    total,
    hasTool: !!msg.tool_calls?.length,
    reasoningLen: (msg.reasoning_content ?? "").length,
    contentLen: (msg.content ?? "").length,
  };
}

/* ---- ② 流式：测首 token 耗时 + 思考链是否下发 ---- */
async function timeStream() {
  const t0 = Date.now();
  let firstTokenAt = null;
  let contentChars = 0;
  let reasoningChars = 0;
  let toolCallChunks = 0;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools, stream: true, stream_options: { include_usage: true } }),
  });
  if (!res.body) return { total: -1, firstTokenMs: -1, contentChars: 0, reasoningChars: 0, toolCallChunks: 0 };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        const d = obj.choices?.[0]?.delta ?? {};
        if (d.content || d.reasoning_content || d.reasoning || d.tool_calls) {
          if (firstTokenAt === null) firstTokenAt = now - t0;
          contentChars += (d.content ?? "").length;
          reasoningChars += (d.reasoning_content ?? "").length + (d.reasoning ?? "").length;
          if (d.tool_calls) toolCallChunks++;
        }
      } catch { /* ignore */ }
    }
  }
  return { total: Date.now() - t0, firstTokenMs: firstTokenAt ?? -1, contentChars, reasoningChars, toolCallChunks };
}

console.log("=== supervisor 决策耗时构成实测 ===\n");
console.log(`模型: ${model}\n`);

const ns = await timeNonStream();
console.log(`① 非流式：`);
console.log(`   总耗时 ${ns.total}ms · 有工具调用=${ns.hasTool} · reasoning ${ns.reasoningLen} 字 · content ${ns.contentLen} 字`);

await new Promise((r) => setTimeout(r, 2000));

const st = await timeStream();
console.log(`② 流式：`);
console.log(`   首 token ${st.firstTokenMs}ms · 总耗时 ${st.total}ms`);
console.log(`   content ${st.contentChars} 字 · reasoning ${st.reasoningChars} 字 · tool_calls 分片 ${st.toolCallChunks} 个`);

console.log(`\n=== 结论 ===`);
if (st.reasoningChars === 0 && ns.reasoningLen > 0) {
  console.log("⚠️ 流式下网关**不下发思考链**（非流式有 " + ns.reasoningLen + " 字，流式 0 字）");
  console.log("   → 流式唯一的提前量是 tool_calls 分片，但 arguments 是 JSON，");
  console.log("     必须拼完才能解析 → 用户依然看不到任何决策过程");
  console.log("   → **流式化对 supervisor 的实际收益 ≈ 0，不做**（P2-⑫ 取消）");
  console.log("   → 思考链已通过非流式 reasoning_content 立即推给前端，价值已拿到");
} else {
  console.log(`✅ 流式下有思考链（${st.reasoningChars} 字）→ 流式化有收益，可以做`);
}
