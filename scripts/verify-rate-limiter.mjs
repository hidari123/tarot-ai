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
  acquireSlotForTest, resetBucketsForTest, rateConfig, tightenOnRateLimit,
} from "../src/lib/agent/llm.ts";

const cfg = rateConfig("p1");
console.log("=== 令牌桶速率限制器验证 ===\n");
console.log(`配置: 每分钟 ${cfg.perMin} 次 · 窗口内 ${cfg.burst} 次 · 启用=${cfg.enabled}`);
console.log(`  → 稳态间隔 = ${(60_000 / cfg.perMin).toFixed(0)}ms`);
console.log(`  → 令牌补充速率 = ${(cfg.perMin / 60).toFixed(2)} 个/秒`);
console.log(`  → 滚动窗口 = ${(cfg.windowMs / 1000).toFixed(0)}s（语义：最近 ${cfg.windowMs / 1000}s 内最多 ${cfg.burst} 次）\n`);

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
  // ⚠️ 期望值：等**滑动窗口腾位置**的时间（约 windowMs）。
  //    因为上游配额是"窗口内 N 次"—— 令牌攒够了也得等窗口空出位置。
  //    （最小间隔只有 10 秒，比窗口短，所以窗口是更严的那个）
  const expected = Math.max(
    Math.ceil(60_000 / cfg.perMin),
    cfg.windowMs
  );
  check(
    "额度耗尽后进入等待（滑动窗口腾位置）",
    !r.granted && Math.abs(r.waitMs - expected) < 200,
    `需等 ${r.waitMs}ms（期望 ≈${expected}ms）`
  );
}

/* ---- ③ 空闲足够久后恢复放行 ---- */
{
  resetBucketsForTest();
  for (let i = 0; i < cfg.burst; i++) await acquireSlotForTest("p3", 0);
  const idleMs = 30_000;
  const r = await acquireSlotForTest("p3", idleMs);
  // ⚠️ 空闲 30 秒 < 窗口 40 秒 → 窗口内还有 4 条记录 → 仍被拦。
  //    这正是滑动窗口的语义：**空闲不等于能发**，
  //    只要窗口内还有记录占着位置，就不能发。
  const bothReady = await acquireSlotForTest("p3", cfg.windowMs + 1000);
  check(
    "空闲超过窗口长度后恢复放行",
    !r.granted && bothReady.granted,
    r.granted
      ? "30 秒就放行了（窗口语义失效）"
      : `30s 被拦（等 ${r.waitMs}ms）→ 满足两项后放行`
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

/* ---- ⑥ 滑动窗口：语义必须与上游配额一致 ---- */
{
  // ⚠️ 这是本次修复的核心断言。
  //    上游语义 = 「滚动 40 秒内最多 4 次」。
  //    纯令牌桶做不到：用户思考久了会攒满令牌 → 连发 → 撞窗口。
  //    滑动窗口必须保证：**任何时刻往前推 windowMs，次数都 ≤ burst**。
  resetBucketsForTest();

  const W = cfg.windowMs;
  /** 独立记录放行时刻（不依赖实现，交叉验证窗口语义） */
  const stamps = [];
  // 模拟一整场占卜：14 次调用，模拟用户思考时间（间隔 3~15 秒）
  const gaps = [5000, 8000, 12000, 3000, 15000, 6000, 9000, 4000, 11000, 7000, 5000, 13000, 8000, 6000];
  let t = 0;
  let maxInWindow = 0;
  let violation = null;
  for (let i = 0; i < gaps.length; i++) {
    t += gaps[i];
    const r = await acquireSlotForTest("pw", t);
    if (r.granted) {
      // 独立统计：rel 时刻往前 W 毫秒窗口内已有几次
      const inWin = stamps.filter((s) => s > t - W).length + 1;
      if (inWin > maxInWindow) maxInWindow = inWin;
      if (inWin > cfg.burst) violation = `第 ${i + 1} 次时窗口内有 ${inWin} 次 > ${cfg.burst}`;
      stamps.push(t);
    }
  }

  check(
    `滑动窗口：任何时刻窗口内不超过 ${cfg.burst} 次`,
    violation === null,
    violation ?? `实测最大 ${maxInWindow} 次`
  );
  check(
    "滑动窗口：长空档后不会攒额度连发",
    maxInWindow <= cfg.burst,
    `最大窗口内次数 = ${maxInWindow}`
  );

  // 显式验证：窗口过期后可以放行
  resetBucketsForTest();
  let t2 = 0;
  for (let i = 0; i < cfg.burst; i++) {
    await acquireSlotForTest("pw2", t2);
    t2 += 1000;
  }
  const blocked = await acquireSlotForTest("pw2", t2);
  check(
    "窗口内已满 → 被拦下并给出等待时间",
    !blocked.granted && blocked.waitMs > 0,
    blocked.granted ? "竟然放行了" : `需等 ${blocked.waitMs}ms`
  );

  // 等窗口过期后再来 → 应该放行
  // ⚠️ 可能仍被**最小间隔**拦下（距上次放行不足 10 秒）——
  //    这是"取更严者"的正确行为，不是 bug。
  const afterWindow = await acquireSlotForTest("pw2", t2 + W + 100);
  const bothReady = await acquireSlotForTest("pw2", t2 + W + 100);
  check(
    "窗口过期后恢复放行",
    bothReady.granted,
    afterWindow.granted
      ? "窗口过期即放行"
      : `窗口过期仍需等最小间隔 ${afterWindow.waitMs}ms → ${bothReady.granted ? "满足后放行" : "仍未放行"}`
  );
}

/* ---- ⑦ 自适应收紧（收到 429 后）---- */
{
  resetBucketsForTest();
  const before = rateConfig("p1");

  // 先用掉额度
  // ⚠️ 用**真实时间基准**（Date.now()）——
  //    tightenOnRateLimit 内部用 Date.now() 填满窗口，
  //    若这里用 virtualNow=0（1970 年），记录会被窗口剔除 → 测不到真实行为。
  const t0 = Date.now();
  for (let i = 0; i < before.burst; i++) await acquireSlotForTest("p1", t0 + i);

  // 收到 429 → 收紧
  tightenOnRateLimit("p1");
  const after = rateConfig("p1");

  check(
    "429 后速率系数下降（乘性减）",
    after.scale < before.scale,
    `${before.scale.toFixed(2)}× → ${after.scale.toFixed(2)}×`
  );
  check(
    "429 后实际每分钟请求数下降",
    after.effectivePerMin < before.effectivePerMin,
    `${before.effectivePerMin} → ${after.effectivePerMin} 次/分`
  );

  // 429 后不立刻再发
  // ⚠️ 必须用**贴近真实时间的 virtualNow**：
  //    tightenOnRateLimit 填满窗口时用的是 Date.now()，
  //    而前面 4 次测试调用用的是 virtualNow=0（1970 年）——
  //    那些记录会被窗口剔除，导致窗口不满 → 测不到真实行为。
  const now = Date.now();
  const afterReset = await acquireSlotForTest("p1", now);
  check(
    "429 后不立刻再发（窗口被填满 → 至少等一个窗口过期）",
    !afterReset.granted,
    afterReset.granted ? "竟然立即放行了" : `需等 ${afterReset.waitMs}ms`
  );

  // 连续 429 → 继续收紧，但有下限
  for (let i = 0; i < 10; i++) tightenOnRateLimit("p1");
  const floor = rateConfig("p1");
  check(
    "连续 429 不会降到下限以下",
    floor.scale >= 0.25,
    `scale=${floor.scale.toFixed(3)}（下限 0.25）`
  );
  // ⚠️ 计算"跑完一场占卜要多久"必须按**真实滑动窗口语义**：
  //    窗口 windowMs 内最多 N 次 → 每 windowMs 发 N 次。
  //    剩余调用数 = 14 - burst（burst 次在第一个窗口内用掉）。
  const windowsNeeded = Math.ceil((14 - cfg.burst) / Math.max(1, floor.effectiveBurst));
  const minutes = (windowsNeeded * cfg.windowMs) / 60_000;
  check(
    "收紧后仍能跑完一场占卜（14 次调用 < 12min deadline）",
    minutes < 12,
    `容量 ${floor.effectiveBurst} 次/${cfg.windowMs / 1000}s → 还需 ${windowsNeeded} 个窗口 ≈ ${minutes.toFixed(1)} 分钟`
  );

  // 恢复：reset 后回到初始速率
  resetBucketsForTest();
  check(
    "reset 后回到初始速率",
    rateConfig("p1").scale === 1,
    `scale=${rateConfig("p1").scale}`
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
