/**
 * LLM Provider 管理 —— 多模型 failover（主备切换）
 *
 * 配置（.env.local）：
 *   # 主模型
 *   DEEPSEEK_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
 *   # 备用模型（可选，主模型不可用时自动切换）
 *   FALLBACK_API_KEY / FALLBACK_BASE_URL / FALLBACK_MODEL
 *
 * 切换策略：
 *   - 触发：网络错误 / 超时(AbortError) / HTTP 5xx / 429
 *   - 粘性：切换到备用后记忆 PROBE_INTERVAL（默认 10 分钟），
 *     期间直接用备用不再探测主用，避免每次调用先吃一次超时
 *   - 流式：首 token 前失败可安全切换；已开始输出后失败不切（避免重复推送）
 */

export interface LLMProvider {
  name: string;      // 展示名（dashboard/日志用）
  apiKey: string;
  baseURL: string;
  model: string;
}

/** 从环境变量构建 provider 列表（主 → 备） */
export function buildProviders(): LLMProvider[] {
  const candidates: LLMProvider[] = [];

  const mainKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  if (mainKey) {
    candidates.push({
      name: process.env.OPENAI_MODEL || "deepseek-chat",
      apiKey: mainKey,
      baseURL: process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1",
      model: process.env.OPENAI_MODEL || "deepseek-chat",
    });
  }

  const fbKey = process.env.FALLBACK_API_KEY;
  if (fbKey) {
    candidates.push({
      name: process.env.FALLBACK_MODEL || "fallback",
      apiKey: fbKey,
      baseURL: process.env.FALLBACK_BASE_URL || "https://api.minimaxi.com/v1",
      model: process.env.FALLBACK_MODEL || "MiniMax-M3",
    });
  }

  // ---- 按 PRIMARY_PROVIDER 排序 ----
  // 例：PRIMARY_PROVIDER=MiniMax-M3 → MiniMax 为主，glm 为备
  const primary = process.env.PRIMARY_PROVIDER;
  if (primary) {
    const idx = candidates.findIndex((p) => p.name === primary || p.model === primary);
    if (idx > 0) {
      const [picked] = candidates.splice(idx, 1);
      candidates.unshift(picked);
    }
  }

  return candidates;
}

/** provider 是否可用（无 key 的跳过） */
export function hasProviders(): boolean {
  return buildProviders().length > 0;
}

/* ---- 健康记忆（进程级） ---- */

interface ProviderHealth {
  /** 上次失败时间；健康为 null */
  failedAt: number | null;
}

const health = new Map<string, ProviderHealth>();

/** 主用 provider 的粘性窗口：切换后这段时间内不再探测主用 */
const STICKY_MS = Number(process.env.FAILOVER_STICKY_MS) || 10 * 60 * 1000;

/** provider 近期是否失败（在粘性窗口内） */
export function isRecentlyFailed(p: LLMProvider): boolean {
  const h = health.get(p.name);
  return !!h?.failedAt && Date.now() - h.failedAt < STICKY_MS;
}

/** 标记 provider 失败（触发后续切换） */
export function markFailed(p: LLMProvider): void {
  health.set(p.name, { failedAt: Date.now() });
  console.error(`[llm-failover] provider "${p.name}" 标记失败，${Math.round(STICKY_MS / 60000)} 分钟内跳过`);
}

/** 标记 provider 恢复（探测成功时清除失败记忆） */
export function markHealthy(p: LLMProvider): void {
  const h = health.get(p.name);
  if (h?.failedAt) {
    health.set(p.name, { failedAt: null });
    console.error(`[llm-failover] provider "${p.name}" 恢复健康`);
  }
}

/** 选出本次应使用的 provider：跳过近期失败的，从主用开始 */
export function pickProvider(preferred?: LLMProvider): LLMProvider | null {
  const all = buildProviders();
  if (all.length === 0) return null;
  // 指定了 provider 且它健康 → 直接用（会话内粘住同一模型，保证风格一致）
  if (preferred && !isRecentlyFailed(preferred)) return preferred;
  const ok = all.find((p) => !isRecentlyFailed(p));
  return ok ?? all[all.length - 1]; // 全挂了也得选一个（最后尝试）
}

/** 该错误是否应触发 failover（而非业务报错） */
export function isFailoverError(e: unknown, httpStatus?: number): boolean {
  if (httpStatus && httpStatus >= 500) return true;
  if (httpStatus === 429) return true;
  if (e instanceof Error) {
    const msg = e.message;
    if (/timeout|abort|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket/i.test(msg)) return true;
    if (/LLM 调用失败\(5\d\d\)/.test(msg)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 启动主动探测                                                        */
/* ------------------------------------------------------------------ */

/**
 * 启动时并发探测所有 provider，把不可用的直接标记失败。
 *
 * 为什么需要：failover 是"事后切换"——首个请求仍要先撞一次主模型的
 * 连接失败。内网地址不可达时，Windows TCP 连接要 20~80 秒才报错，
 * 用户的第一个请求会白等这么久。启动探测把它挪到服务启动阶段。
 */
export async function probeProviders(timeoutMs = 8000): Promise<void> {
  const all = buildProviders();
  if (all.length === 0) return;

  const results = await Promise.all(
    all.map(async (p) => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${p.baseURL}/models`, {
          method: "GET",
          headers: { Authorization: `Bearer ${p.apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          markHealthy(p);
          return { name: p.name, ok: true, ms: Date.now() - t0 };
        }
        // 有些网关不实现 /models，但 chat 可用 —— 不算失败
        if (res.status === 404 || res.status === 405) {
          return { name: p.name, ok: true, ms: Date.now() - t0, note: "无 /models 端点" };
        }
        markFailed(p);
        return { name: p.name, ok: false, ms: Date.now() - t0, status: res.status };
      } catch (e) {
        markFailed(p);
        return {
          name: p.name, ok: false, ms: Date.now() - t0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    })
  );

  const healthy = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  console.error(
    `[llm-probe] 可用: ${healthy.join(", ") || "无"}${failed.length ? ` | 不可用: ${failed.join(", ")}` : ""}`
  );
}
