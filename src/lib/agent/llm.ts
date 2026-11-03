/**
 * LLM 调用层 —— 统一封装 + 多 provider failover + 熔断器
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 *
 * 三层保护（面试可讲）：
 *   1. 同 provider 瞬时重试（网络抖动 / 5xx）
 *   2. 跨 provider failover（主 → 备）
 *   3. 熔断器（连续失败后主动跳过坏 provider，不让每次调用都吃超时）
 *
 * ⚠️ 流式场景的特殊约束：
 *   首 token **之前**失败 → 可以安全切换 provider（用户什么都没看到）
 *   首 token **之后**失败 → **不能**切换（用户会看到半截 A + 半截 B）
 */

import * as db from "../db";
import { runtimeState } from "../runtime";
import { markTruncated } from "./truncation";
import {
  buildProviders, pickProvider, markHealthy, markFailed, isFailoverError,
  isRecentlyFailed, isHedgedEnabled, raceWithAbort,
  type LLMProvider,
} from "../llm-providers";
import type { SessionMessage, SubAgent } from "./types";

/* ------------------------------------------------------------------ */
/* 熔断器（P1-⑤）                                                      */
/* ------------------------------------------------------------------ */

/**
 * 三态熔断器：closed → open（熔断）→ half-open（试探）
 *
 * ⚠️ 为什么需要它（原来的缺口）：
 *   启动探测能避免"首个请求吃 20~80s 连接超时"，但**运行中**provider
 *   挂掉时，每次调用仍要先挨一次完整超时才切备用。
 *   熔断器让连续失败的 provider 被**主动跳过**，60 秒后再试探。
 */
export class CircuitBreaker {
  /** 连续失败次数 */
  private failures = new Map<string, number>();
  /** 上次失败时间戳 */
  private lastFailure = new Map<string, number>();

  constructor(
    /** 触发熔断的连续失败次数 */
    private readonly threshold = Number(process.env.BREAKER_THRESHOLD) || 3,
    /** 熔断持续时长（默认 60s） */
    private readonly cooldownMs = Number(process.env.BREAKER_COOLDOWN_MS) || 60_000
  ) {}

  /** provider 是否可用（熔断中则跳过） */
  canRequest(name: string): boolean {
    const fails = this.failures.get(name) ?? 0;
    if (fails < this.threshold) return true;
    const last = this.lastFailure.get(name) ?? 0;
    // 冷却期结束 → half-open：放行一次试探
    if (Date.now() - last > this.cooldownMs) return true;
    return false;
  }

  /** 记录成功 → 清零计数 */
  recordSuccess(name: string): void {
    this.failures.delete(name);
    this.lastFailure.delete(name);
  }

  /** 记录失败 → 累加计数 */
  recordFailure(name: string): void {
    this.failures.set(name, (this.failures.get(name) ?? 0) + 1);
    this.lastFailure.set(name, Date.now());
  }

  /** 当前熔断中的 provider 列表（诊断用） */
  openProviders(): string[] {
    const out: string[] = [];
    for (const [name, fails] of this.failures) {
      if (fails >= this.threshold) {
        const last = this.lastFailure.get(name) ?? 0;
        if (Date.now() - last <= this.cooldownMs) out.push(name);
      }
    }
    return out;
  }
}

/**
 * 全局熔断器（跨请求共享 —— provider 的健康度是全局属性）
 *
 * ⚠️ P1-⑥：改用统一的 runtimeState 入口（原来自成一套 globalThis 写法，
 *    分散的单例声明容易漏 —— 现在全部走同一个容器，便于审计）。
 */
export const breaker: CircuitBreaker = runtimeState<CircuitBreaker>(
  "llm.breaker",
  () => new CircuitBreaker()
);

/* ------------------------------------------------------------------ */
/* 基础类型                                                            */
/* ------------------------------------------------------------------ */

export interface CallResult {
  message: {
    role: "assistant";
    content: string;
    tool_calls?: {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }[];
  };
  reasoning?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt?: number };
  provider: string;
}

/** 各子 Agent 的超时预算（analyst 需要更久 —— 它读全部牌面 + 检索结果） */
function llmTimeoutFor(agent: SubAgent): number {
  const base = Number(process.env.LLM_TIMEOUT_MS) || 45_000;
  return agent === "analyst" ? Math.max(base, 90_000) : base;
}

/**
 * 剥离内嵌在 content 里的 <think>思考链标签。
 *
 * 部分模型（MiniMax-M3 等）不提供 reasoning_content 字段，而是把思考过程
 * 直接写进 content 的 <think>...</think> 标签里。若不剥离：
 *   ① 思考过程会混进正文推送给用户
 *   ② 正文 token 被思考占用，可能导致正文为空
 */
export function splitThinkTags(raw: string): { content: string; reasoning?: string } {
  if (!raw || !raw.includes("<think>")) return { content: raw ?? "" };
  const reasoningParts: string[] = [];
  const content = raw.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner) => {
    reasoningParts.push(inner.trim());
    return "";
  });
  const reasoning = reasoningParts.join("\n").trim();
  return {
    content: content.trim(),
    reasoning: reasoning || undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Provider 级速率限制（令牌桶）                                        */
/* ------------------------------------------------------------------ */

/**
 * 速率限制配置 —— 用「每分钟 N 次」描述（贴近上游网关配额的语义）。
 *
 * ⚠️ 为什么需要：上游网关有突发配额（实测内网 glm 网关：
 *    **约 4 次 / 30~40 秒窗口** —— 间隔 20s 连发 5 次全过、间隔 12s 连发 6 次全过；
 *    间隔 8s 时第 5 次被限流、间隔 3s 每次都被限流，
 *    且 "resets at" 随请求时刻滚动）。
 *    而一场占卜要打 ~14 次 LLM 往返（承约/呼召/选牌/检索/3×(翻牌+解读)/综合+收束），
 *    间隔仅 1~2 秒 —— **必然打满窗口**，表现为 429 → 降级 → 质量指标失真。
 *
 *    熔断器只能"事后"跳过坏掉的 provider（30~60 秒冷却），
 *    限流是"事前"的节奏问题 —— 需要主动节流。
 *
 * ⚠️ 为什么用令牌桶而不是"固定最小间隔"：
 *    固定间隔（如 20 秒）只能表达"稳态速率"，无法表达"突发额度"——
 *    而网关配额恰恰是「窗口内 N 次」的突发语义。
 *    令牌桶可以同时表达两者：
 *      capacity = 窗口内允许的突发次数（如 4）
 *      refillRate = 每秒补充的令牌数（如 3/60）
 *    效果：空闲一段时间后能攒下额度（短时突发不排队），
 *    持续高频调用则被均摊到 refillRate（长期速率受控）。
 *    固定间隔做不到这点 —— 它连"攒额度"的概念都没有。
 *
 *    配置（环境变量）：
 *      LLM_RATE_PER_MIN    等价速率（默认 4 = 容量 × 60 / 窗口，仅用于展示）
 *      LLM_RATE_BURST      **窗口内**允许的次数（默认 4 = 实测真实配额）
 *      LLM_RATE_WINDOW_MS  窗口长度（默认 60_000 = 实测滚动窗口）
 *      LLM_RATE_ENABLED    设为 0 关闭限流（配额充足时）
 *
 * ⚠️ 为什么必须有滑动窗口（纯令牌桶解决不了）：
 *    上游配额是「**滚动 40 秒内最多 4 次**」——
 *    它不看"你攒了多久"，只看"**最近 60 秒内发了几次**"。
 *    令牌桶是「空闲能攒额度」语义 ——
 *    用户思考 30 秒，桶就攒满令牌，之后能**连发**。
 *    两种语义不匹配 → 攒额度后连发 → 全落在同一个窗口 → 429。
 *    实测：burst=2 的纯令牌桶，30 秒内发了 8 次，第 9 次 429。
 *
 *    所以现在用**滑动窗口 + 令牌桶取更严者**：
 *      滑动窗口：最近 60 秒内不能超过 4 次（与上游字面一致）
 *      （滑动窗口本身已含均摊语义，不再叠加第二个限制）
 *    见下方 RATE_WINDOW_MS 注释。
 */
const RATE_ENABLED = process.env.LLM_RATE_ENABLED !== "0";
const RATE_PER_MIN = Number(process.env.LLM_RATE_PER_MIN ?? 4);
const RATE_BURST = Number(process.env.LLM_RATE_BURST ?? 4);

/**
 * 滑动窗口限流器（与上游配额语义**完全一致**）
 *
 * ⚠️ 为什么必须用滑动窗口，而不是纯令牌桶：
 *    上游配额是「**滚动 N 秒内最多 M 次**」——
 *    它不看"你攒了多久"，只看"**最近 N 秒内发了几次**"。
 *    令牌桶是「空闲能攒额度」语义 ——
 *    用户思考 30 秒，桶就攒满 burst 个令牌，之后能**连发** burst 次。
 *    两种语义不匹配 → 攒额度后连发 → 全落在同一个窗口 → 429。
 *    实测：burst=2 时 30 秒内发了 8 次，第 9 次 429。
 *
 *    滑动窗口直接记录"最近 M 次请求的时间戳"，
 *    放行前先剔除窗口外的旧记录，再看是否已满 ——
 *    语义与上游**逐字一致**，不需要调参试探。
 *
 * ⚠️ 为什么保留令牌桶的 refillRate（LLM_RATE_PER_MIN）：
 *    当 M 次的窗口远长于"期望的最小间隔"时，
 *    滑动窗口会允许短时间连发（比如上游配额是 100 次/天），
 *    这时流量应该被均摊。所以取两者的**更严格者**：
 *      滑动窗口：最近 M 次里不能超过 M
 *      令牌桶：至少每 (60/RATE_PER_MIN) 秒 1 次
 *
 * 配置：
 *   LLM_RATE_PER_MIN   每分钟请求数上限（均摊用，默认 6）
 *   LLM_RATE_BURST     **窗口内**允许的次数（默认 4 = 实测的真实配额）
 *   LLM_RATE_WINDOW_MS 窗口长度（默认 60_000，实测上游滚动窗口 ≈ 60 秒）
 *
 * ⚠️ 有了滑动窗口后，burst 的含义变了：
 *    不再是"突发几次"，而是"**最近 40 秒内最多几次**"——
 *    这正是上游配额的字面语义。
 *    默认 4 = 实测值，可以直接用。
 */
const RATE_WINDOW_MS = Number(process.env.LLM_RATE_WINDOW_MS ?? 60_000);

/** 每个 provider 的限流状态 */
interface Bucket {
  /**
   * 滑动窗口内的请求时间戳（升序）
   * ⚠️ 只保留窗口内的记录 —— 超出即剔除（这就是"滚动窗口"）
   *
   * ⚠️ 关键：**占位必须发生在 await 之前**。
   *    如果等完才 push，两个并发调用会同时读到
   *    "stamps.length < burst" → 都判定窗口未满 → 都放行 →
   *    同一瞬间发出 N 个请求 → 突破上游配额 → 429。
   *    （2026-11 踩过这个坑：单测用 acquireSlotForTest 是对的，
   *      但生产实现把 push 放到了 await 之后 → 单测全绿、线上失效。）
   */
  stamps: number[];
  /**
   * 上次**预定放行**的时刻
   *
   * ⚠️ 为什么需要它（不只是记录）：
   *   并发调用各自算出 waitMs 后都要"占一个坑"。
   *   若只按"窗口是否满"判断，两个并发调用会算出**同一个** waitMs
   *   （都基于 stamps[0]）→ 等完同时放行 → 再次穿透。
   *   正确做法：占位时就把**预定放行时刻**推进，
   *   下一个并发调用会基于新的 stamps[0] 算出更长的等待 → 依次排开。
   */
  lastReleaseAt: number | null;
}
/**
 * P1-⑥：挂到 globalThis —— 原来这里是**模块级** Map，
 * HMR 重载会清空限流窗口 → 立刻连发一批 → 429。
 */
const buckets = runtimeState<Map<string, Bucket>>("llm.buckets", () => new Map<string, Bucket>());

/**
 * 取号：等到有可用令牌才放行（并发调用会各自排队，不会聚在一起）。
 *
 * ⚠️ 关键实现细节：预定时刻（而不是实际发出时刻）写回桶里 ——
 *    否则多个并发调用会同时看到"有令牌"、同时放行，
 *    瞬间打满上游窗口（这正是我们要避免的）。
 *
 * ⚠️ P2-⑪：等待时通知前端（可选回调）
 *    限流节流会让一次 LLM 调用静默等待最多 20 秒 ——
 *    用户在界面上只看到"模型仍在思考…已等待 12s"，
 *    不知道是模型慢还是我们在**主动限速**。
 *    两种等待的性质完全不同，必须区分开：
 *      模型慢   → "模型仍在思考"
 *      主动限速 → "为避免触发服务端限流，正在控制请求节奏"
 *    onWait(waitMs) 回调让调用方把这个信息透出。
 *
 * ⚠️ 自适应收紧（收到 429 后）：
 *    令牌桶的初始额度是**乐观估计**（burst=4），
 *    但上游网关的真实窗口可能更严 —— 实测就是如此：
 *    桶里有 4 个额度 → 前 4 次请求立刻发出 → 全部撞 429。
 *    所以收到 429 时必须**立刻收紧**：清空桶 + 降低补充速率。
 *    这是标准的自适应限流（AIMD：加性增、乘性减）。
 */
async function acquireSlot(
  providerName: string,
  onWait?: (waitMs: number) => void
): Promise<void> {
  if (!RATE_ENABLED || RATE_PER_MIN <= 0) return;

  // ⚠️ 用 effectiveBurst（受自适应系数影响）而非固定的 RATE_BURST ——
  //    撞过 429 之后窗口容量会自动变小（更保守）。
  const burst = effectiveBurst(providerName);
  const now = Date.now();

  let bucket = buckets.get(providerName);
  if (!bucket) {
    bucket = { stamps: [], lastReleaseAt: null };
    buckets.set(providerName, bucket);
  }

  /* ---- ① 滑动窗口检查：最近 RATE_WINDOW_MS 内已发了几次 ---- */
  // 剔除窗口外的旧记录（这就是"滚动"）
  const windowStart = now - RATE_WINDOW_MS;
  bucket.stamps = bucket.stamps.filter((t) => t > windowStart);

  // 窗口内已满 → 必须等最老那条过期
  const windowWaitMs =
    bucket.stamps.length >= burst
      ? Math.max(0, bucket.stamps[0] + RATE_WINDOW_MS - now + 50)
      : 0;

  /* ---- ② 放行判定 ---- */
  // ⚠️ 为什么不再叠加"最小间隔"限制：
  //   滑动窗口本身就已经实现了均摊 —— 窗口 40 秒内最多 4 次
  //   = 6 次/分钟 = 每 10 秒 1 次，与 LLM_RATE_PER_MIN 是同一件事。
  //   之前额外加"距上次放行 ≥ 10 秒"，结果把**合法的突发也挡了**：
  //   上游允许 40 秒内连发 4 次，而我们只放 1 次 —— 反而更慢、
  //   而且没有换来任何额外的保护。
  //
  //   所以滑动窗口是**唯一**的限流器：
  //     语义与上游逐字一致（"最近 40 秒内最多 4 次"）
  //     不多限，也不错放。
  const waitMs = windowWaitMs;

  if (waitMs > 0) {
    // ⚠️⚠️ 关键顺序：**先占位，再等待**
    //    （这是 2026-11 修过的 bug：原来 push 在 await 之后，
    //      导致并发调用同时判定"窗口未满" → 同时放行 → 穿透窗口 → 429 风暴。
    //      而单测用的 acquireSlotForTest 是正确写法 → 单测全绿、线上失效。
    //      教训：**注释不是证据，代码才是** —— 测试钩子必须与生产实现同源。）
    const releaseAt = now + waitMs;
    // ⚠️ 推入的是**预定放行时刻**（未来），不是当前时刻：
    //    这样下一个并发调用会基于新的 stamps[0] 算出**更长**的等待 → 依次排开。
    bucket.stamps.push(releaseAt);
    bucket.stamps.sort((a, b) => a - b);
    bucket.lastReleaseAt = releaseAt;
    // P2-⑪：告知调用方"正在限速等待"，让前端能区分"模型慢"与"主动限速"
    onWait?.(waitMs);
    await new Promise((r) => setTimeout(r, waitMs));
    return;
  }

  /* ---- ③ 立即放行：也必须占位（否则并发会同时穿透）---- */
  const releaseNow = Date.now();
  bucket.stamps.push(releaseNow);
  bucket.lastReleaseAt = releaseNow;
}

/**
 * 收到 429 后的**自适应收紧**（AIMD：乘性减）
 *
 * ⚠️ 为什么需要（实测踩到的坑）：
 *   令牌桶的初始额度 burst=4 是**乐观估计**，
 *   但上游网关的真实窗口可能更严（实测：桶里有 4 个额度时，
 *   前 4 个请求立刻发出 → 全部撞 429）。
 *   也就是说：**乐观的初始额度 = 一开局就撞墙**。
 *
 *   收到 429 说明我们的估计偏乐观 → 立刻：
 *     ① 清空窗口记录（不立刻再发）
 *     ② **收缩窗口容量**（下次允许的次数更少）
 *   连续收到 429 会持续收缩，直到找到能通过的配额。
 *   （AIMD 的 "Multiplicative Decrease"：越撞越保守）
 *
 * ⚠️ 为什么收缩的是"窗口容量"而不是"速率"：
 *   现在滑动窗口是唯一的限流器，
 *   窗口容量（RATE_BURST）才是直接决定"多久发 N 次"的参数。
 *   收缩它 = 立刻把节奏降下来，语义直观。
 *
 * ⚠️ 下限为什么是 1 而不是 0：
 *   容量收缩到 0 会导致完全无法请求（死锁）。
 *   下限 1 = "60 秒内只放 1 次"= 1 次/分 ——
 *   一场占卜 ~14 次 ≈ 9 分钟，仍在 12min 看门狗内。
 *   真要更保守，应该调小 LLM_RATE_BURST 本身（显式配置，而非自动降级）。
 *
 * ⚠️ 为什么不做成"永久收紧"：
 *   上游配额可能恢复（换了 key、窗口变了）。
 *   所以设一个下限，并且**随时间缓慢回升** ——
 *   由"每次请求时按流逝时间补一点容量"实现（见 effectiveBurst）。
 *
 * ⚠️⚠️ 为什么系数是 **per-provider** 而不是全局：
 *   配额是**每个 provider 独立**的。
 *   如果用一个全局系数，主用（MiniMax）被打满配额时，
 *   备用（glm）的窗口容量也会被砍到 0.25× ——
 *   于是"本可以正常服务的备用"也被降速，**failover 变得毫无意义**。
 *   实测教训：拥塞传染比限流本身更致命。
 */
interface ProviderRateState {
  /** 容量系数（1 = 初始容量，越小越保守） */
  scale: number;
  /** 上次调整的时刻（用于缓慢回升） */
  lastAdjust: number;
}
/**
 * per-provider 的速率状态
 *
 * ⚠️ P1-⑥：挂到 globalThis（HMR 重载会丢掉"已收紧"的状态）
 */
const rateStates = runtimeState<Map<string, ProviderRateState>>(
  "llm.rateStates",
  () => new Map<string, ProviderRateState>()
);

/** 容量系数随时间缓慢回升（每秒 +1%） */
const SCALE_RECOVERY_PER_SEC = 0.01;
/** 下限：0.25× → 4×0.25 = 1 次/60 秒 = 1 次/分 */
const SCALE_MIN = 0.25;

/**
 * 当前生效的窗口容量（受自适应系数影响）
 *
 * ⚠️ 为什么用 Math.ceil 而不是 Math.floor：
 *   floor(4 × 0.5) = 2，floor(4 × 0.25) = 1 —— 都在 1 以上，能用。
 *   但如果基础 burst 是 3，floor(3 × 0.25) = 0 → 完全不能请求（死锁）。
 *   ceil 保证至少 1。
 */
function effectiveBurst(providerName: string): number {
  const st = rateStates.get(providerName);
  if (!st) return RATE_BURST;
  // 缓慢回升
  const now = Date.now();
  const elapsedSec = (now - st.lastAdjust) / 1000;
  if (elapsedSec > 0 && st.scale < 1) {
    st.scale = Math.min(1, st.scale + elapsedSec * SCALE_RECOVERY_PER_SEC);
    st.lastAdjust = now;
  }
  return Math.max(1, Math.ceil(RATE_BURST * st.scale));
}

/** 当前生效的每分钟请求数（等价于 窗口容量 × 60 / 窗口长度） */
function effectivePerMin(providerName: string): number {
  return (effectiveBurst(providerName) * 60_000) / RATE_WINDOW_MS;
}

/**
 * 收到 429 → 收紧**该 provider** 的窗口容量
 *
 * ⚠️ 必须 per-provider：429 来自某一个具体 provider，
 *    收紧全局会让其它 provider 一起变慢（拥塞传染）。
 */
export function tightenOnRateLimit(providerName: string): void {
  const st = rateStates.get(providerName) ?? { scale: 1, lastAdjust: Date.now() };
  const before = st.scale;
  st.scale = Math.max(SCALE_MIN, st.scale * 0.5);
  st.lastAdjust = Date.now();
  rateStates.set(providerName, st);

  // ⚠️ 关键：**不要清空 stamps**。
  //   清空 = 窗口腾空 = 下一次立刻放行 = 刚撞了 429 就再撞一次。
  //   正确做法是让**容量收缩**（effectiveBurst 变小），
  //   窗口里已有的记录自然让下一次等更久。
  //
  //   这里反而要**填满**窗口（把容量位置占住），
  //   保证"429 之后至少等一个窗口过期"再试 —— 这是标准的退避。
  const bucket = buckets.get(providerName);
  if (bucket) {
    const now = Date.now();
    // ⚠️ 必须**填满到窗口容量**（不是"补足差额"）：
    //   收到 429 意味着上游窗口已经满了 ——
    //   我们的窗口计数可能少于上游的（因为我们只知道自己发过几次）。
    //   所以要把窗口**填到当前容量**，让下一次至少等一个窗口过期。
    const target = effectiveBurst(providerName);
    while (bucket.stamps.length < target) {
      // 用略微错开的时刻填满（模拟"刚刚占用了这些位置"）
      bucket.stamps.push(now - (target - bucket.stamps.length) * 10);
    }
    bucket.stamps.sort((a, b) => a - b);
  }
  console.error(
    `[llm-rate] ${providerName} 收到 429，窗口容量收紧 ${before.toFixed(2)}× → ${st.scale.toFixed(2)}×` +
    `（现在 ${effectiveBurst(providerName)} 次/${RATE_WINDOW_MS / 1000}s）`
  );
}

/** 收到 429 → 收紧窗口容量 */
/* ------------------------------------------------------------------ */
/* 测试钩子（让验证脚本与实现同源，避免"复制算法"的漂移风险）            */
/* ------------------------------------------------------------------ */
/** 当前生效的限流配置（受自适应系数影响） */
export function rateConfig(providerName = "default"): {
  enabled: boolean; perMin: number; burst: number; windowMs: number;
  scale: number; effectivePerMin: number; effectiveBurst: number;
} {
  const st = rateStates.get(providerName);
  return {
    enabled: RATE_ENABLED, perMin: RATE_PER_MIN, burst: RATE_BURST,
    windowMs: RATE_WINDOW_MS,
    scale: st?.scale ?? 1,
    // ⚠️ 不取整 —— 取整会让"显示的速率"与"实际等待时间"不一致
    //    （比如真实是 1.5 次/分，显示成 2 次/分 → 断言与实际行为脱节）
    effectivePerMin: Math.round(effectivePerMin(providerName) * 100) / 100,
    effectiveBurst: effectiveBurst(providerName),
  };
}

/** 清空所有令牌桶 + 重置自适应系数（测试隔离用） */
export function resetBucketsForTest(): void {
  buckets.clear();
  rateStates.clear();
}

/**
 * 测试用的取号入口 —— **不真的等待**，只返回"本该等多久"。
 *
 * ⚠️ 为什么这样设计：令牌桶的等待时长是它的**可观测输出**，
 *    单测要断言的正是这个数字。真等 20 秒会让测试无法运行。
 */
export async function acquireSlotForTest(
  providerName: string,
  virtualNow: number
): Promise<{ granted: boolean; waitMs: number }> {
  let bucket = buckets.get(providerName);
  if (!bucket) {
    bucket = { stamps: [], lastReleaseAt: null };
    buckets.set(providerName, bucket);
  }

  /* 滑动窗口检查（与 acquireSlot 同源逻辑 —— 唯一的限流器） */
  const windowStart = virtualNow - RATE_WINDOW_MS;
  bucket.stamps = bucket.stamps.filter((t) => t > windowStart);
  const waitMs =
    bucket.stamps.length >= effectiveBurst(providerName)
      ? Math.max(0, bucket.stamps[0] + RATE_WINDOW_MS - virtualNow + 50)
      : 0;

  if (waitMs > 0) {
    // ⚠️ 模拟真实实现的完整过程：**预定放行时刻**（未来时刻）。
    //    真实 acquireSlot 等完会在该时刻放行并占用窗口位置。
    //    测试钩子若不预登记，后续调用的窗口计数就会与真实行为脱节。
    //
    // ⚠️⚠️ 这段逻辑必须与 acquireSlot **逐字对应**：
    //    2026-11 踩过"钩子对、实现错"的坑 ——
    //    钩子先 push、生产实现后 push，导致并发穿透而单测全绿。
    //    教训：注释不是证据，代码才是。
    const releaseAt = virtualNow + waitMs;
    bucket.stamps.push(releaseAt);
    bucket.stamps.sort((a, b) => a - b);
    bucket.lastReleaseAt = releaseAt;
    return { granted: false, waitMs };
  }
  bucket.stamps.push(virtualNow);
  bucket.lastReleaseAt = virtualNow;
  return { granted: true, waitMs: 0 };
}

/* ------------------------------------------------------------------ */
/* 非流式调用                                                          */
/* ------------------------------------------------------------------ */

/** 单次原始 HTTP 调用（不 failover；快速网络抖动在同 provider 重试 1 次） */
async function rawCall(
  p: LLMProvider,
  messages: SessionMessage[],
  tools: unknown[] | undefined,
  sessionId: string | undefined,
  agent: SubAgent,
  /**
   * 外部取消信号（并行择优用）
   * ⚠️ 为什么需要：竞速时落败的那一路必须能**主动 abort**，
   *    否则它会继续跑完（继续烧 token + 占节流槽位）。
   *    AbortSignal.timeout 无法被外部取消，所以这里把两个信号合流。
   */
  externalSignal?: AbortSignal,
  /**
   * P2-⑪：限速等待通知（可选）
   * ⚠️ 用途：让调用方把"正在限速等待"透给用户 ——
   *    用户看到的应该是"为避免触发服务端限流，正在控制请求节奏"，
   *    而不是含糊的"模型仍在思考"（这两件事的性质完全不同）。
   */
  onRateLimitWait?: (waitMs: number) => void
): Promise<CallResult> {
  const timeoutMs = llmTimeoutFor(agent);
  const attempt = async (): Promise<CallResult> => {
    await acquireSlot(p.name, onRateLimitWait);
    const t0 = Date.now();
    // 合并"超时"与"外部取消"两个信号：
    //   AbortSignal.any 在 Node 20+ 可用（两个信号任一触发就 abort）
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
    const res = await fetch(`${p.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages,
        ...(tools ? { tools } : {}),
        stream: false,
        max_tokens: agent === "analyst" ? 3000 : agent === "reviewer" ? 2000 : undefined,
        // 思维链分级（实测教训）：
        // - supervisor 决策必须保留推理：无思维链时模型会跳过工具直接文本回答
        //   （实测 money 用例 10 tools → 0 tools，退化成聊天机器人）
        // - analyst/reviewer 是结构化任务，关掉提速
        ...(agent === "supervisor" ? {} : { thinking: { type: "disabled" } }),
      }),
      signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      db.logLLMUsage(sessionId ?? null, agent, p.name, 0, 0, Date.now() - t0, false);
      if (sessionId) db.logTiming(sessionId, `llm_${agent}`, Date.now() - t0, `${p.name} fail`);
      // ⚠️ 429 → 自适应收紧速率（见 tightenOnRateLimit 的说明）：
      //    我们的初始额度是乐观估计，撞到 429 说明偏快 → 立刻变保守。
      if (res.status === 429) tightenOnRateLimit(p.name);
      throw new Error(`LLM 调用失败(${res.status}): ${errText.slice(0, 200)}`);
    }
    const json = await res.json();
    db.logLLMUsage(
      sessionId ?? null, agent, p.name,
      json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0,
      Date.now() - t0, true
    );
    // LLM 调用耗时落库（瀑布数据：llm_supervisor / llm_analyst / ...）
    if (sessionId) db.logTiming(sessionId, `llm_${agent}`, Date.now() - t0, p.name);
    markHealthy(p);
    breaker.recordSuccess(p.name);
    const choice = json.choices?.[0];
    // Provider 适配：部分模型（如 MiniMax）把思考链内嵌在 content 的 <think> 标签里，
    // 且没有 reasoning_content 字段 —— 必须剥离，否则思考过程会混进正文推给用户
    const { content, reasoning } = splitThinkTags(choice?.message?.content ?? "");
    return {
      message: {
        role: "assistant",
        content,
        tool_calls: choice?.message?.tool_calls,
      },
      reasoning: choice?.message?.reasoning_content ?? reasoning,
      usage: json.usage,
      provider: p.name,
    };
  };

  // 瞬时网络错误（断连/重置/5xx）先在同一个 provider 上重试一次，
  // 仍失败才交给上层 callLLM 走 failover 换 provider。
  // 例外：超时（abort）不原地重试 —— 首次已烧满 45s 预算，再等 45s 才切换
  // 体验太差，直接 failover；业务错误（4xx）不重试直接抛。
  try {
    return await attempt();
  } catch (e) {
    const timedOut = e instanceof Error && /timeout|abort/i.test(e.message);
    if (timedOut || !isFailoverError(e)) throw e;
    return await attempt();
  }
}

/**
 * 非流式调用（决策/分析/审校）——失败自动切换备用 provider
 *
 * ⚠️ 熔断器接入点：在**尝试顺序**里跳过熔断中的 provider。
 *
 * ⚠️ 并行择优（hedged request）的触发条件（见 llm-providers.ts 的详细说明）：
 *    只有在「**已知主用可能有问题**」时才开双路 —— 否则白白多烧一份配额。
 *    判定：主用 provider 近期失败过（isRecentlyFailed），
 *    或探活时不可用。此时让备用与主用**同时**发请求，谁先回用谁。
 */
export async function callLLM(
  config: LLMProvider | null,
  messages: SessionMessage[],
  tools?: unknown[],
  sessionId?: string,
  agent: SubAgent = "supervisor",
  /** P2-⑪：限速等待通知（见 rawCall 的同名参数说明） */
  onRateLimitWait?: (waitMs: number) => void
): Promise<CallResult> {
  const all = buildProviders();
  if (all.length === 0) throw new Error("未配置任何 LLM provider");

  // 尝试顺序：首选（会话粘住的/健康的）→ 其余未失败的
  const preferred = pickProvider(config ?? undefined) ?? all[0];
  const order = [preferred, ...all.filter((p) => p !== preferred)];

  /* ---- 并行择优：仅在「主用疑似有问题」且有备用时才启用 ---- */
  if (isHedgedEnabled() && order.length >= 2 && isRecentlyFailed(preferred)) {
    const hedgeOrder = order.slice(0, 2); // 只竞速前两个（更多就失去意义了）
    const aborters: Array<() => void> = [];
    const controllers = hedgeOrder.map(() => new AbortController());
    hedgeOrder.forEach((_, i) => {
      aborters.push(() => controllers[i].abort());
    });
    try {
      const race = await raceWithAbort(
        hedgeOrder.map((p) => ({
          providerName: p.name,
          run: (signal: AbortSignal) => rawCall(p, messages, tools, sessionId, agent, signal, onRateLimitWait),
        })),
        aborters
      );
      // 赢家要标记健康；输家若是因为限流/故障失败，也要标记失败
      const winner = hedgeOrder.find((p) => p.name === race.providerName);
      if (winner) markHealthy(winner);
      for (const loserName of race.losers) {
        const loser = hedgeOrder.find((p) => p.name === loserName);
        if (loser) markFailed(loser);
      }
      console.error(
        `[llm-hedge] 并行择优: ${race.providerName} 胜出（${race.elapsedMs}ms）` +
        (race.losers.length ? ` · 落败: ${race.losers.join(", ")}` : "")
      );
      return race.winner;
    } catch (e) {
      // 并行择优整体失败 → 落回串行 failover（下方的循环）
      console.error(`[llm-hedge] 并行择优失败，回退串行:`, e instanceof Error ? e.message : e);
    }
  }

  let lastErr: unknown = null;
  for (const p of order) {
    // 熔断中 → 直接跳过（不挨超时）
    if (!breaker.canRequest(p.name)) {
      lastErr = new Error(`LLM provider「${p.name}」处于熔断状态，暂时跳过`);
      continue;
    }
    try {
      return await rawCall(p, messages, tools, sessionId, agent, undefined, onRateLimitWait);
    } catch (e) {
      lastErr = e;
      if (isFailoverError(e)) {
        markFailed(p);
        breaker.recordFailure(p.name);
        continue; // 切下一个 provider
      }
      throw e; // 业务错误（4xx 参数问题等）不切换
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("所有 LLM provider 均不可用");
}

/* ------------------------------------------------------------------ */
/* 流式调用                                                            */
/* ------------------------------------------------------------------ */

/**
 * 流式调用（撰写者）——首 token 前失败自动切换备用 provider；输出开始后不再切换
 */
export async function* streamLLM(
  config: LLMProvider | null,
  messages: SessionMessage[],
  sessionId: string | undefined,
  agent: SubAgent = "writer"
): AsyncGenerator<string> {
  const all = buildProviders();
  if (all.length === 0) throw new Error("未配置任何 LLM provider");
  const preferred = pickProvider(config ?? undefined) ?? all[0];
  const order = [preferred, ...all.filter((p) => p !== preferred)];

  let lastErr: unknown = null;
  for (const p of order) {
    // 熔断中 → 跳过
    if (!breaker.canRequest(p.name)) {
      lastErr = new Error(`LLM provider「${p.name}」处于熔断状态，暂时跳过`);
      continue;
    }
    const gotAnyOutput = yield* tryStreamOnce(p, messages, sessionId, agent, (e) => { lastErr = e; });
    if (gotAnyOutput === "ok") return; // 成功跑完
    // ⚠️ P3-⑩："truncated" = 已经输出了内容但流被中断（正文不完整）
    //    不能当作成功（那会让半截正文拿到 pass:true → **假绿灯**），
    //    但也**不能**换 provider 重试（重发会重复输出已给用户的半截）。
    //    处理：记录到 DB（让指标能归因），然后结束本次流。
    if (gotAnyOutput === "truncated") {
      // ⚠️ logTiming 要求非空 sessionId（没有会话上下文时跳过记录）
      if (sessionId) {
        db.logTiming(
          sessionId,
          `stream_truncated_${agent}`,
          0,
          `输出被截断（provider=${p.name}）`
        );
      }
      console.error(
        `[llm] 流被截断（${agent}/${p.name}）—— 已输出内容保留，但**不标记为成功**`
      );
      // ⚠️ 在 session 上打标记（供审校环节判断"这次正文不完整"）
      //    ⚠️ 为什么用 session 表而不是全局 Set：
      //    标记是**会话级**的（别的会话的截断不该影响这一场的审校），
      //    而且 llm.ts 不应该直接依赖 agent/session.ts（会造成循环导入）——
      //    所以通过一个独立的标记表实现（见 markTruncated）。
      markTruncated(sessionId);
      return;
    }
    // gotAnyOutput === "pre-output-fail"：还没输出任何内容，可安全换下一个 provider 重试
  }
  throw lastErr instanceof Error ? lastErr : new Error("所有 LLM provider 均不可用（流式）");
}

/** 单次流式尝试：返回 "ok"（完成）或 "pre-output-fail"（首 token 前失败，可重试） */
async function* tryStreamOnce(
  p: LLMProvider,
  messages: SessionMessage[],
  sessionId: string | undefined,
  agent: SubAgent,
  onFail: (e: unknown) => void
): AsyncGenerator<string, "ok" | "pre-output-fail" | "truncated"> {
  const t0 = Date.now();
  let res: Response;
  try {
    await acquireSlot(p.name);
    res = await fetch(`${p.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        messages,
        stream: true,
        // 流式调用方：writer（6000，长文创作）与 analyst（2500，精简笔记）
        max_tokens: agent === "analyst" ? 2500 : 6000,
        thinking: { type: "disabled" },
        // 请求 usage 统计（OpenAI 兼容：usage 只在最后一个分片返回）
        stream_options: { include_usage: true },
      }),
      // 流式给更宽的超时（首 token 慢 + 流式传输）
      signal: AbortSignal.timeout(llmTimeoutFor("writer") * 2),
    });
  } catch (e) {
    db.logLLMUsage(sessionId ?? null, agent, p.name, 0, 0, Date.now() - t0, false);
    onFail(e);
    if (isFailoverError(e)) { markFailed(p); breaker.recordFailure(p.name); }
    return "pre-output-fail";
  }
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => res.statusText);
    db.logLLMUsage(sessionId ?? null, agent, p.name, 0, 0, Date.now() - t0, false);
    // ⚠️ 429 → 自适应收紧（同非流式路径）
    if (res.status === 429) tightenOnRateLimit(p.name);
    const err = new Error(`LLM 流式调用失败(${res.status}): ${errText.slice(0, 200)}`);
    onFail(err);
    if (isFailoverError(err, res.status)) { markFailed(p); breaker.recordFailure(p.name); }
    return "pre-output-fail";
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalChars = 0;
  const streamFilter = createStreamThinkFilter();
  const reasoningParts: string[] = [];
  /** 流式 usage（OpenAI 兼容协议：usage 在最后一个分片，需 stream_options.include_usage） */
  let usagePrompt = 0;
  let usageCompletion = 0;
  let usageAvailable = false;

  /** 落库：优先用网关给的真实 usage，缺失时用字符数估算并标注 */
  const logUsage = (ok: boolean) => {
    const estPrompt = usageAvailable ? usagePrompt : Math.round(totalChars * 1.5);
    const estCompletion = usageAvailable ? usageCompletion : totalChars;
    db.logLLMUsage(
      sessionId ?? null, agent, p.name,
      estPrompt, estCompletion, Date.now() - t0, ok
    );
  };

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      // 流中断：若已有输出则放弃（不切避免重复推送）；无输出则可重试
      logUsage(totalChars === 0);
      onFail(e);
      if (totalChars === 0 && isFailoverError(e)) { markFailed(p); breaker.recordFailure(p.name); }
      // ⚠️ 中断但已有输出 = 内容被截断。
      // ⚠️ P3-⑩：这里的 `as "ok"` 是**类型断言**，它骗过了编译器 ——
      //    调用方收到的仍然是 "ok"，看不到"截断"这个事实。
      //    后果：截断的正文照常送审落库 → reviewer 给一个基于半截正文的评分
      //    → `pass: true` 落库 → **审校指标是伪影**（假绿灯）。
      //    修法：把 "truncated" 纳入返回类型（去掉断言），
      //    并让调用方显式处理（记录 + 不让截断内容拿 pass）。
      if (totalChars > 0) {
        console.error(`[llm] 流中断但已有 ${totalChars} 字输出（${agent}/${p.name}），内容可能截断`);
        return "truncated";
      }
      return "pre-output-fail";
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        logUsage(true);
        markHealthy(p);
        breaker.recordSuccess(p.name);
        return "ok";
      }
      try {
        const json = JSON.parse(data);
        // 流式 usage：仅在带 include_usage 的最后一个分片出现
        if (json.usage) {
          usageAvailable = true;
          usagePrompt = json.usage.prompt_tokens ?? 0;
          usageCompletion = json.usage.completion_tokens ?? 0;
        }
        const delta = json.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          // 标准思考链字段（glm 等）——单独透出
          reasoningParts.push(delta.reasoning_content);
        }
        if (delta?.content) {
          // 内容可能内嵌 <think> 标签（MiniMax 等），需流式剥离
          const { content: clean, reasoning } = streamFilter.push(delta.content);
          if (reasoning) reasoningParts.push(reasoning);
          if (clean) { totalChars += clean.length; yield clean; }
        }
      } catch { /* 忽略 */ }
    }
  }
  // 流结束：冲刷过滤器残留
  const tail = streamFilter.flush();
  if (tail.content) { totalChars += tail.content.length; yield tail.content; }
  if (tail.reasoning) reasoningParts.push(tail.reasoning);

  logUsage(true);
  markHealthy(p);
  breaker.recordSuccess(p.name);
  return "ok";
}

/**
 * 流式 think 标签过滤器（状态机）
 *
 * 难点：<think> 标签可能跨 SSE chunk 分割（"…<thi" + "nk>思考…</think>"），
 * 所以必须保留不完整的尾部片段到下一个 chunk 再判断。
 */
function createStreamThinkFilter() {
  let buf = "";        // 待判定的缓冲
  let inThink = false; // 当前是否在 think 区内

  return {
    /** 输入一个 chunk，返回可安全输出的正文与提取到的思考链 */
    push(text: string): { content: string; reasoning?: string } {
      buf += text;
      let out = "";
      const reasoningParts: string[] = [];

      while (true) {
        if (inThink) {
          const end = buf.indexOf("</think>");
          if (end === -1) {
            // 未闭合：保留可能是半个标签的尾巴，其余都是思考内容
            const keep = buf.match(/<\/?thi?nk?>?$/);
            const safeLen = keep ? buf.length - keep[0].length : 0;
            if (safeLen > 0) { reasoningParts.push(buf.slice(0, safeLen)); buf = buf.slice(safeLen); }
            break;
          }
          reasoningParts.push(buf.slice(0, end));
          buf = buf.slice(end + "</think>".length);
          inThink = false;
          continue;
        }
        const start = buf.indexOf("<think>");
        if (start === -1) {
          // 没有开始标签：输出全部，但保留可能是半个开始标签的尾巴
          const keep = buf.match(/<$/);
          const safeLen = keep ? buf.length - keep[0].length : buf.length;
          if (safeLen > 0) { out += buf.slice(0, safeLen); buf = buf.slice(safeLen); }
          break;
        }
        out += buf.slice(0, start);
        buf = buf.slice(start + "<think>".length);
        inThink = true;
      }

      const reasoning = reasoningParts.join("").trim();
      return { content: out, reasoning: reasoning || undefined };
    },

    /** 流结束时冲刷残留 */
    flush(): { content: string; reasoning?: string } {
      const rest = buf;
      buf = "";
      if (inThink) {
        inThink = false;
        return { content: "", reasoning: rest.trim() || undefined };
      }
      return { content: rest, reasoning: undefined };
    },
  };
}
