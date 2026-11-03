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

/** 全局熔断器（跨请求共享 —— provider 的健康度是全局属性） */
const gBreaker = globalThis as unknown as { __tarotBreaker__?: CircuitBreaker };
export const breaker: CircuitBreaker = gBreaker.__tarotBreaker__ ?? new CircuitBreaker();
gBreaker.__tarotBreaker__ = breaker;

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
 *      LLM_RATE_PER_MIN  每分钟允许的请求数（默认 3，约等于实测安全值）
 *      LLM_RATE_BURST   允许的突发次数（默认 4）
 *      LLM_RATE_ENABLED  设为 0 关闭限流（配额充足时）
 */
const RATE_ENABLED = process.env.LLM_RATE_ENABLED !== "0";
const RATE_PER_MIN = Number(process.env.LLM_RATE_PER_MIN ?? 3);
const RATE_BURST = Number(process.env.LLM_RATE_BURST ?? 4);

/** 每个 provider 的令牌桶状态 */
interface Bucket {
  /** 当前可用令牌 */
  tokens: number;
  /** 上次补充令牌的时刻 */
  lastRefill: number;
}
const buckets = new Map<string, Bucket>();

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
 */
async function acquireSlot(
  providerName: string,
  onWait?: (waitMs: number) => void
): Promise<void> {
  if (!RATE_ENABLED || RATE_PER_MIN <= 0) return;

  const refillPerMs = RATE_PER_MIN / 60_000;
  const now = Date.now();

  let bucket = buckets.get(providerName);
  if (!bucket) {
    bucket = { tokens: RATE_BURST, lastRefill: now };
    buckets.set(providerName, bucket);
  }
  // 按经过时间补充令牌（上限 = 突发容量）
  const elapsed = now - bucket.lastRefill;
  bucket.tokens = Math.min(RATE_BURST, bucket.tokens + elapsed * refillPerMs);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return; // 有令牌，立即放行
  }

  // 没令牌 → 算出需要等多久才能攒出 1 个
  const deficit = 1 - bucket.tokens;
  const waitMs = Math.ceil(deficit / refillPerMs);
  // ⚠️ 预定时刻写回：后续并发调用会接着往后排，不会一起冲出去
  bucket.tokens = 0;
  bucket.lastRefill = now + waitMs;
  // P2-⑪：告知调用方"正在限速等待"，让前端能区分"模型慢"与"主动限速"
  onWait?.(waitMs);
  await new Promise((r) => setTimeout(r, waitMs));
}

/* ------------------------------------------------------------------ */
/* 测试钩子（让验证脚本与实现同源，避免"复制算法"的漂移风险）            */
/* ------------------------------------------------------------------ */

/** 当前速率限制配置（只读快照） */
export function rateConfig(): { enabled: boolean; perMin: number; burst: number } {
  return { enabled: RATE_ENABLED, perMin: RATE_PER_MIN, burst: RATE_BURST };
}

/** 清空所有令牌桶（测试隔离用） */
export function resetBucketsForTest(): void {
  buckets.clear();
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
  const refillPerMs = RATE_PER_MIN / 60_000;
  let bucket = buckets.get(providerName);
  if (!bucket) {
    bucket = { tokens: RATE_BURST, lastRefill: virtualNow };
    buckets.set(providerName, bucket);
  }
  const elapsed = virtualNow - bucket.lastRefill;
  bucket.tokens = Math.min(RATE_BURST, bucket.tokens + elapsed * refillPerMs);
  bucket.lastRefill = virtualNow;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { granted: true, waitMs: 0 };
  }
  const deficit = 1 - bucket.tokens;
  const waitMs = Math.ceil(deficit / refillPerMs);
  bucket.tokens = 0;
  bucket.lastRefill = virtualNow + waitMs;
  return { granted: false, waitMs };
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
): AsyncGenerator<string, "ok" | "pre-output-fail"> {
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
      // ⚠️ 中断但已有输出 = 内容被截断。旧逻辑静默当"正常完成"，
      // 截断正文照常送审落库，用户看到戛然而止却显示流程完成。
      // 现在显式返回截断标记，调用方可见。
      if (totalChars > 0) {
        console.error(`[llm] 流中断但已有 ${totalChars} 字输出（${agent}/${p.name}），内容可能截断`);
        return "truncated" as "ok";
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
