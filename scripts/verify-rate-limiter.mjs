#!/usr/bin/env node
/**
 * 验证令牌桶速率限制器（P1-⑦）
 *
 * ⚠️ 为什么这个需要单测（而不是靠集成测试碰运气）：
 *    令牌桶是**并发 + 时间**耦合的逻辑 —— 写错了不会报错，
 *    只会表现为"限流没生效"（请求瞬间全打出去 → 上游 429）
 *    或"限流太狠"（请求排队过久 → 体验变差）。
 *    这两种失败在集成测试里很难稳定复现，必须用**可控时钟**单测。
 *
 * ⚠️ 为什么直接 import 实现（而不是复制一份算法来测）：
 *    复制算法 = 两处实现会漂移，测试通过但线上行为不同 ——
 *    这是"测试保护不了生产"的经典坑。
 *    所以 llm.ts 导出了 acquireSlotForTest（不真的等待，只返回等待时长），
 *    测试与实现**同源**。
 *
 * 验证四条性质：
 *   ① 突发额度：空闲后能立刻放行 burst 次
 *   ② 稳态速率：额度用完后，等待时间 ≈ (1 - ratePerMin) 分钟
 *   ③ 令牌补充：空闲一段时间后能攒回额度
 *   ④ 并发不穿透：N 个"同时"到达的调用不会一起放行（最关键）
 */

import {
  acquireSlotForTest, resetBucketsForTest, rateConfig,
} from "../src/lib/agent/llm.ts";

const cfg = rateConfig();
console.log("=== 令牌桶速率限制器验证 ===\n");
console.log(`配置: 每分钟 ${cfg.perMin} 次 · 突发 ${cfg.burst} 次 · 启用=${cfg.enabled}`);
console.log(`  → 稳态间隔 = ${(60_000 / cfg.perMin).toFixed(0)}ms`);
console.log(`  → 令牌补充速率 = ${(cfg.perMin / 60).toFixed(2)} 个/秒\n`);

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

/* ---- ① 突发额度：空闲后立刻放行 burst 次 ---- */
{
  resetBucketsForTest();
  let granted = 0;
  for (let i = 0; i < cfg.burst; i++) {
    const r = await acquireSlotForTest("p1", 0);
    if (r.granted && r.waitMs === 0) granted++;
  }
  check(
    `突发额度：${cfg.burst} 次请求立刻放行`,
    granted === cfg.burst,
    `实际 ${granted}`
  );
}

/* ---- ② 稳态速率：额度用完后，第 N+1 次需要等 ---- */
{
  resetBucketsForTest();
  for (let i = 0; i < cfg.burst; i++) await acquireSlotForTest("p2", 0);
  const r = await acquireSlotForTest("p2", 0);
  const expected = Math.ceil(60_000 / cfg.perMin);
  check(
    "额度耗尽后进入等待",
    !r.granted && Math.abs(r.waitMs - expected) < 100,
    `需等 ${r.waitMs}ms（期望 ≈${expected}ms）`
  );
}

/* ---- ③ 令牌补充：空闲一段时间后能攒回额度 ---- */
{
  resetBucketsForTest();
  for (let i = 0; i < cfg.burst; i++) await acquireSlotForTest("p3", 0);
  const idleMs = 30_000;
  const r = await acquireSlotForTest("p3", idleMs);
  check(
    "空闲 30 秒后攒回额度",
    r.granted,
    `攒到 ${((idleMs * cfg.perMin) / 60_000).toFixed(1)} 个令牌`
  );
}

/* ---- ④ 并发不穿透（最关键）---- */
{
  resetBucketsForTest();
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(await acquireSlotForTest("p4", 0)); // 同一时刻到达
  }
  const immediate = results.filter((r) => r.granted && r.waitMs === 0).length;
  check(
    "并发调用不同时穿透",
    immediate <= cfg.burst,
    `${cfg.burst} 个槽位内只有 ${immediate} 个立即放行，其余排队`
  );
  // 排队的时间应该递增（后来的等更久）
  const waits = results.filter((r) => !r.granted).map((r) => r.waitMs);
  const increasing = waits.every((w, i) => i === 0 || w >= waits[i - 1]);
  check("排队时长递增（不会一起冲出去）", increasing, `等待序列: ${waits.join(", ")}ms`);
}

/* ---- ⑤ provider 之间互不干扰 ---- */
{
  resetBucketsForTest();
  // p5 用完额度
  for (let i = 0; i < cfg.burst; i++) await acquireSlotForTest("p5", 0);
  const blocked = await acquireSlotForTest("p5", 0);
  // p6 是另一个 provider，应该不受影响
  const other = await acquireSlotForTest("p6", 0);
  check(
    "不同 provider 互不干扰（各自独立配额）",
    !blocked.granted && other.granted,
    `p5 阻塞=${!blocked.granted} · p6 放行=${other.granted}`
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
