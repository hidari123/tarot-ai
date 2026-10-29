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
/* 非流式调用                                                          */
/* ------------------------------------------------------------------ */

/** 单次原始 HTTP 调用（不 failover；快速网络抖动在同 provider 重试 1 次） */
async function rawCall(
  p: LLMProvider,
  messages: SessionMessage[],
  tools: unknown[] | undefined,
  sessionId: string | undefined,
  agent: SubAgent
): Promise<CallResult> {
  const timeoutMs = llmTimeoutFor(agent);
  const attempt = async (): Promise<CallResult> => {
    const t0 = Date.now();
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
      signal: AbortSignal.timeout(timeoutMs),
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
 */
export async function callLLM(
  config: LLMProvider | null,
  messages: SessionMessage[],
  tools?: unknown[],
  sessionId?: string,
  agent: SubAgent = "supervisor"
): Promise<CallResult> {
  const all = buildProviders();
  if (all.length === 0) throw new Error("未配置任何 LLM provider");

  // 尝试顺序：首选（会话粘住的/健康的）→ 其余未失败的
  const preferred = pickProvider(config ?? undefined) ?? all[0];
  const order = [preferred, ...all.filter((p) => p !== preferred)];

  let lastErr: unknown = null;
  for (const p of order) {
    // 熔断中 → 直接跳过（不挨超时）
    if (!breaker.canRequest(p.name)) {
      lastErr = new Error(`LLM provider「${p.name}」处于熔断状态，暂时跳过`);
      continue;
    }
    try {
      return await rawCall(p, messages, tools, sessionId, agent);
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
