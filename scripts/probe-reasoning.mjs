#!/usr/bin/env node
/**
 * 探查 glm 的思考链在流式/非流式下的形态差异
 *
 * 背景：非流式响应里有 981 字 reasoning，但流式分片里只有 content/role。
 * 需要确认：思考链在流式下是被**丢弃**了，还是被**混进了 content**？
 * 这决定了流式化能否带来"思考过程实时可见"的收益。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envText = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* ignore */ }

const key = process.env.DEEPSEEK_API_KEY;
const base = process.env.OPENAI_BASE_URL;
const model = process.env.OPENAI_MODEL;

const tools = [{
  type: "function",
  function: {
    name: "establish_contract",
    description: "承约",
    parameters: { type: "object", properties: { question: { type: "string" } } },
  },
}];

console.log("=== ① 非流式：思考链在哪 ===");
{
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, messages: [{ role: "user", content: "我最近工作压力很大" }], tools, stream: false,
    }),
  });
  const json = await res.json();
  const msg = json.choices?.[0]?.message ?? {};
  console.log(`   message 字段: ${Object.keys(msg).join(", ")}`);
  console.log(`   reasoning_content 长度: ${(msg.reasoning_content ?? "").length}`);
  console.log(`   content 长度: ${(msg.content ?? "").length}`);
  console.log(`   content 前 120 字: ${String(msg.content ?? "").slice(0, 120)}`);
  console.log(`   content 含 <think> 标签: ${String(msg.content ?? "").includes("<think>")}`);
}

console.log("\n=== ② 流式：全部 delta 内容拼起来看 ===");
{
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, messages: [{ role: "user", content: "我最近工作压力很大" }], tools, stream: true,
    }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", all = "";
  const keys = new Set();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const d = JSON.parse(data).choices?.[0]?.delta ?? {};
        Object.keys(d).forEach((k) => keys.add(k));
        all += d.content ?? "";
        if (d.tool_calls) all += `[TOOLCALLS:${JSON.stringify(d.tool_calls).slice(0, 80)}]`;
      } catch { /* ignore */ }
    }
  }
  console.log(`   delta 字段: ${[...keys].join(", ")}`);
  console.log(`   拼接总长: ${all.length}`);
  console.log(`   含 <think>: ${all.includes("<think>")}`);
  console.log(`   前 200 字: ${all.slice(0, 200)}`);
}
