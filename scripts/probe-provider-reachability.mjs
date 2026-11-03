#!/usr/bin/env node
/**
 * 探针：测试各 provider 的可达性（用 Node fetch —— 与生产运行时一致）
 *
 * ⚠️ 为什么不用 PowerShell / curl 测：
 *    之前用 Invoke-WebRequest 测 MiniMax 得到"基础连接已经关闭"，
 *    差点误判成"这台机器没有公网出口"。
 *    但 Node 的 fetch（undici）与 .NET 的 HttpClient 在 TLS/代理/HTTP2 上行为不同 ——
 *    **必须用与生产相同的运行时测**，否则结论不可信。
 *    这正是"实测要用对工具"的又一次印证。
 *
 * 用法：npx tsx scripts/probe-provider-reachability.mjs
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

const providers = [
  {
    name: "MiniMax-M3（公网）",
    base: process.env.FALLBACK_BASE_URL,
    key: process.env.FALLBACK_API_KEY,
    model: process.env.FALLBACK_MODEL,
  },
  {
    name: "glm-5.3（内网网关）",
    base: process.env.OPENAI_BASE_URL,
    key: process.env.DEEPSEEK_API_KEY,
    model: process.env.OPENAI_MODEL,
  },
];

console.log("=== Provider 可达性探针（Node fetch）===\n");

for (const p of providers) {
  if (!p.base || !p.key) {
    console.log(`${p.name}: ⚠️ 未配置，跳过\n`);
    continue;
  }
  const url = `${p.base}/chat/completions`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: "user", content: "说一个字" }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - t0;
    if (res.ok) {
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content ?? "";
      const reasoning = j.choices?.[0]?.message?.reasoning_content ?? "";
      console.log(`${p.name}: ✅ ${res.status} (${ms}ms)`);
      console.log(`   model=${j.model}`);
      console.log(`   content: ${String(content).slice(0, 60).replace(/\n/g, " ")}`);
      if (reasoning) console.log(`   reasoning: ${String(reasoning).length} 字`);
    } else {
      const text = await res.text().catch(() => "");
      console.log(`${p.name}: ❌ HTTP ${res.status} (${ms}ms)`);
      console.log(`   ${text.slice(0, 200)}`);
    }
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`${p.name}: ❌ ${e.name}: ${e.message} (${ms}ms)`);
    if (e.cause) console.log(`   cause: ${e.cause.code ?? e.cause.message}`);
  }
  console.log("");
}
