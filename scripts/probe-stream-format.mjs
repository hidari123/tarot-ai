#!/usr/bin/env node
/**
 * 探查 glm 网关的流式响应格式（决定流式化实现方式）
 *
 * ⚠️ 为什么必须先探查：
 *    不同网关的流式字段不一样：
 *      OpenAI 兼容：delta.content / delta.reasoning_content / delta.tool_calls
 *      部分网关：delta.reasoning / delta.thinking
 *    猜错字段名 = 流式化后"思考过程不显示"（功能看起来没生效）。
 *    与其猜，不如打一次看看真实结构。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envText = readFileSync(join(__dirname, "..", ".env.local"), "utf-8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch { /* ignore */ }

const key = process.env.DEEPSEEK_API_KEY;
const base = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const model = process.env.OPENAI_MODEL || "deepseek-chat";

const res = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "用一句话解释塔罗牌的占卜原理" }],
    stream: true,
    stream_options: { include_usage: true },
  }),
});

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
let n = 0;
const deltaKeys = new Set();
let sampleToolCall = null;

while (n < 12) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const data = t.slice(5).trim();
    if (data === "[DONE]") { n = 99; break; }
    try {
      const obj = JSON.parse(data);
      const d = obj.choices?.[0]?.delta ?? {};
      Object.keys(d).forEach((k) => deltaKeys.add(k));
      if (d.tool_calls && !sampleToolCall) sampleToolCall = JSON.stringify(d.tool_calls).slice(0, 200);
      n++;
      if (n <= 3) console.log(`分片 ${n}: ${data.slice(0, 220)}`);
    } catch { /* ignore */ }
  }
}

console.log(`\n出现过的 delta 字段: ${[...deltaKeys].join(", ")}`);
if (sampleToolCall) console.log(`tool_calls 分片样例: ${sampleToolCall}`);
