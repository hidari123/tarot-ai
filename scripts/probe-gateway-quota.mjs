#!/usr/bin/env node
/**
 * 探针：实测上游网关的真实配额（2026-11-03 内网 glm 网关）
 *
 * ⚠️ 为什么需要这个脚本（而不是拍脑袋配 LLM_RATE_PER_MIN）：
 *   令牌桶的速率必须匹配上游的**真实**配额，否则一开局就撞 429。
 *   而配额是**环境相关**的 —— 不同网关、不同 key、不同时间都可能不同。
 *   所以必须能**随时实测**。
 *
 * ⚠️ 为什么要留档：
 *   "我们限速配的是多少"这种数字会随环境失效。
 *   把探针脚本留在仓库里，换环境时改几个参数就能重新测，
 *   而不是靠记忆猜。
 *
 * 实测结论（内网 172.20.65.66:4000，key 已在 .env.local）：
 *   **滚动 30~40 秒窗口，窗口内 4 次**
 *     间隔 10s 连发 → 第 4 次 429
 *     间隔  9s 连发 → 第 5 次 429（第 8 次又成功 = 窗口滚动重置）
 *     间隔 20s 连发 → 全部通过
 *
 *   → 安全的生产配置：LLM_RATE_PER_MIN=6（每 10 秒 1 次）
 *                      LLM_RATE_BURST=2（突发别贪，4 个会瞬间撞掉窗口里 3 个）
 *
 * 用法：npx tsx scripts/probe-gateway-quota.mjs [间隔秒数] [次数]
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ⚠️ Node 不自动加载 .env —— 手动解析 .env.local
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
const base = process.env.OPENAI_BASE_URL;
const model = process.env.OPENAI_MODEL;
const intervalSec = Number(process.argv[2]) || 10;
const times = Number(process.argv[3]) || 6;

if (!key || !base) {
  console.log("⚠️ 未配置 DEEPSEEK_API_KEY / OPENAI_BASE_URL，跳过");
  process.exit(0);
}

console.log(`=== 网关配额探针 ===\n`);
console.log(`端点: ${base}`);
console.log(`模型: ${model}`);
console.log(`间隔: ${intervalSec}s · 次数: ${times}\n`);

let ok = 0;
let limited = 0;
let other = 0;
const marks = [];

for (let i = 1; i <= times; i++) {
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: "说一个字" }],
    max_tokens: 8,
  });
  try {
    const t0 = Date.now();
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body,
    });
    if (res.ok) {
      ok++;
      marks.push(`${i}:✅`);
      console.log(`  第 ${i} 次: ✅ (${Date.now() - t0}ms)`);
    } else {
      const text = await res.text().catch(() => "");
      if (res.status === 429) {
        limited++;
        marks.push(`${i}:429`);
        console.log(`  第 ${i} 次: ❌ 429（窗口内次数已用尽）`);
      } else {
        other++;
        marks.push(`${i}:${res.status}`);
        console.log(`  第 ${i} 次: ❌ HTTP ${res.status} — ${text.slice(0, 120)}`);
      }
    }
  } catch (e) {
    other++;
    marks.push(`${i}:ERR`);
    console.log(`  第 ${i} 次: ❌ ${e.message}`);
  }
  if (i < times) await new Promise((r) => setTimeout(r, intervalSec * 1000));
}

console.log(`\n=== 结果 ===`);
console.log(`  成功 ${ok} · 429 限流 ${limited} · 其他错误 ${other}`);
console.log(`  序列: ${marks.join(" ")}`);
console.log(
  limited === 0
    ? `  → ${intervalSec}s 间隔稳定（建议 LLM_RATE_PER_MIN=${Math.floor(60 / intervalSec)}，burst 取 1~2）`
    : `  → ${intervalSec}s 间隔仍会限流，窗口内约 ${ok} 次 —— 建议把间隔调大到 ${Math.ceil(intervalSec * 1.5)}s 以上`
);
