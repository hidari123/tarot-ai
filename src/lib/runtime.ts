/**
 * 运行时单例（跨请求共享状态的唯一入口）
 *
 * ⚠️ 为什么要这个模块（2026-11 审计发现）：
 *   项目里有一堆"跨请求共享的内存状态"，但各处声明方式**不一致**：
 *     · session.ts 的会话表 → globalThis ✅
 *     · llm.ts 的熔断器   → globalThis ✅
 *     · db.ts 的连接句柄   → globalThis ✅
 *     · event-log.ts 的事件缓冲 → 模块级 ❌
 *     · llm.ts 的限流桶     → 模块级 ❌
 *     · llm-providers.ts 的健康度 → 模块级 ❌
 *     · tools/rag.ts 的检索缓存 → 模块级 ❌
 *     · session.ts 的 dirty 集合 → 模块级 ❌
 *
 *   两种声明方式的差别（**不是风格问题，是功能问题**）：
 *     · 模块级变量在 Next dev 的 **HMR 重载**时会重置（模块重新求值）
 *       → 限流窗口清空 → 立刻连发一批 → 429
 *       → 熔断状态丢失 → 已知坏掉的 provider 又被调用
 *     · globalThis 挂在全局对象上，HMR 时不会丢
 *
 * ⚠️⚠️ 关于"多 worker"的诚实说明（**不要误解**）：
 *   globalThis **只能解决 HMR 热重载**，**不能解决多进程**。
 *   `next start`（standalone）默认起多个 worker，每个 worker 有**独立的 JS realm**
 *   → 各自的 globalThis 也是独立的。
 *   所以：
 *     · 同一 worker 内：globalThis 保证一致 ✅（本模块解决的就是这个）
 *     · 跨 worker：仍然分裂 ❌
 *   跨 worker 要真正解决，必须把热状态外置（Redis / DB）
 *   或**强制单 worker 部署**（本项目的做法，见 docs/deployment.md）。
 *
 * ⚠️ 为什么不把全部状态塞进一个 globalThis 对象：
 *   那样各模块之间会形成**导入依赖环**（runtime → sessions → runtime）。
 *   所以这里只提供"容器 + 取用函数"，具体类型用泛型/any 保持松耦合，
 *   由各模块自己注册自己的状态。
 */

/** 运行时容器的类型（各模块按 key 注册自己的状态） */
type RuntimeStore = Record<string, unknown>;

/** 拿到全局唯一的运行时容器 */
function getStore(): RuntimeStore {
  const g = globalThis as unknown as { __tarotRuntime__?: RuntimeStore };
  if (!g.__tarotRuntime__) g.__tarotRuntime__ = {};
  return g.__tarotRuntime__;
}

/**
 * 获取（或创建）一个命名空间内的状态
 *
 * ⚠️ 为什么用"工厂函数"而不是直接赋值：
 *   直接 `runtime.foo = new Map()` 在模块重复求值时会**覆盖**已有状态
 *   （HMR 时丢掉限流窗口）—— 恰好是要避免的问题。
 *   工厂函数保证"已存在就复用"。
 *
 * @param key   命名空间 key（如 "llm.buckets"）
 * @param create 创建函数（只在首次调用时执行）
 */
export function runtimeState<T>(key: string, create: () => T): T {
  const store = getStore();
  if (!(key in store)) {
    store[key] = create();
  }
  return store[key] as T;
}

/**
 * 运行时健康信息（供 /api/health 使用）
 *
 * ⚠️ 用途：部署时能确认"这是几个 worker、状态是否共享"。
 *   多 worker 时各 worker 报告各自的 pid —— 能立刻看出分裂。
 */
export function runtimeInfo(): {
  pid: number;
  namespaces: string[];
  nodeEnv: string;
} {
  const store = getStore();
  return {
    pid: process.pid,
    namespaces: Object.keys(store).sort(),
    nodeEnv: process.env.NODE_ENV ?? "development",
  };
}

/**
 * 清空全部运行时状态（仅测试用）
 */
export function resetRuntimeForTest(): void {
  const g = globalThis as unknown as { __tarotRuntime__?: RuntimeStore };
  g.__tarotRuntime__ = {};
}
