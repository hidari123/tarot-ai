#!/usr/bin/env node
/**
 * 验证 P0-1：滑动窗口限流器的并发穿透（生产实现 vs 测试钩子）
 *
 * ⚠️ 这是 2026-11-03 最重要的一个 bug —— 而且是**上一轮修复引入的**：
 *
 *   生产实现 acquireSlot（llm.ts:310-322）：
 *     if (waitMs > 0) {
 *       bucket.lastReleaseAt = releaseAt;   // ← 只写了字段，没占窗口位置
 *       await sleep(waitMs);                // ← 等待
 *     }
 *     bucket.stamps.push(releaseNow);       // ← 占位在 await **之后**
 *
 *   测试钩子 acquireSlotForTest（llm.ts:475）：
 *     if (waitMs > 0) {
 *       bucket.stamps.push(releaseAt);       // ← 占位在 await **之前**（正确）
 *       ...
 *     }
 *
 *   → 钩子是对的、实现是错的 → 单测全绿，但生产并发时窗口失效。
 *   这正是架构文档里"测试钩子漂移"那条教训的**反向案例**。
 *
 * ⚠️ 为什么这个 bug 极其致命：
 *   占卜是长流程（14 次 LLM 往返），且并行择优会同时打两个 provider。
 *   一旦窗口判定同时放行，实际请求速率 = N × 单请求速率
 *   → 直接突破上游「滚动 60s 内 4 次」配额 → 429 → 降级 → 质量指标失真。
 *
 * 本脚本用**真实并发**（Promise.all）复现穿透：
 *   窗口容量 4，同时发起 8 个调用 → 正确实现最多放行 4 个。
 */

import { acquireSlotForTest, rateConfig, resetBucketsForTest } from "../src/lib/agent/llm.ts";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== P0-1 滑动窗口并发穿透验证 ===\n");
const cfg = rateConfig();
console.log(`  配置: 窗口 ${cfg.windowMs / 1000}s 内 ${cfg.burst} 次\n`);

/* ---- ① 测试钩子（已知正确）：并发下应严格限制在容量内 ---- */
{
  resetBucketsForTest();
  const N = 8;
  // 模拟并发：同时发起 N 个调用
  const results = await Promise.all(
    Array.from({ length: N }, () => acquireSlotForTest("cc", 0))
  );
  const granted = results.filter((r) => r.granted).length;
  check(
    `测试钩子：${N} 个并发调用只放行 ${cfg.burst} 个`,
    granted <= cfg.burst,
    `实际放行 ${granted} 个`
  );
}

/* ---- ② 生产实现：模拟"占位在 await 之后"的语义 ---- */
{
  // ⚠️ 这里**不复现**实现，而是验证"如果占位在 await 之后会怎样"，
  //    证明这个顺序差异是致命的。
  resetBucketsForTest();
  const stamps = [];
  const burst = cfg.burst;

  // 错误语义的模拟：判断时读 stamps，等完才 push
  const buggyAcquire = async () => {
    const now = Date.now();
    const windowStart = now - cfg.windowMs;
    const live = stamps.filter((t) => t > windowStart);
    const waitMs = live.length >= burst ? Math.max(0, live[0] + cfg.windowMs - now + 50) : 0;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 10))); // 缩短等待便于测试
    }
    stamps.push(Date.now());
  };

  await Promise.all(Array.from({ length: 8 }, () => buggyAcquire()));
  check(
    "「占位在 await 之后」的语义 → 并发下突破窗口容量",
    stamps.length > burst,
    `放行了 ${stamps.length} 个 > 容量 ${burst}`
  );
  console.log("     ↑ 这就是当前生产实现的语义 —— 窗口在并发下失效");
}

/* ---- ③ 检查生产代码里 stamps.push 的位置是否在 await 之后 ---- */
{
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, "..", "src", "lib", "agent", "llm.ts"), "utf8");

  // 取出 acquireSlot 函数体
  const m = src.match(/async function acquireSlot\([\s\S]*?\n\}/);
  const body = m ? m[0] : "";

  // ⚠️ 关键：生产实现必须在 await **之前**占位。
  //    取"第一次出现 stamps.push"的位置，与 await 的位置比较。
  const awaitIdx = body.indexOf("await new Promise");
  const pushIdx = body.indexOf("bucket.stamps.push");

  check(
    "生产实现：窗口占位在 await **之前**（并发安全）",
    pushIdx > 0 && awaitIdx > 0 && pushIdx < awaitIdx,
    pushIdx < awaitIdx
      ? `占位在位置 ${pushIdx}，await 在 ${awaitIdx} → 已修复`
      : `stamps.push 在位置 ${pushIdx}，await 在位置 ${awaitIdx} → 占位在等待之后（并发会穿透）`
  );

  // 检查 tightenOnRateLimit 是否 per-provider
  const takesProvider = /tightenOnRateLimit\s*\(\s*\w+\s*:\s*string/.test(src);
  check(
    "tightenOnRateLimit 是 per-provider 的（不误伤其它 provider）",
    takesProvider,
    takesProvider ? "" : "当前是全局收紧 → 一个 provider 的 429 会拖慢所有 provider"
  );

  // 检查 rateScale 是否还是全局变量
  const globalScale = /let rateScale = 1/.test(src);
  check(
    "rateScale 是 per-provider 的（拥塞不传染）",
    !globalScale,
    globalScale ? "当前是全局变量 → 拥塞传染" : "已改为 per-provider Map"
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
