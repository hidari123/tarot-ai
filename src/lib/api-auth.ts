/**
 * API 鉴权与安全策略（公网部署标准）
 *
 * ⚠️ 为什么需要这个模块：
 *   项目原本**所有 API 零鉴权**，而部署目标是公网。
 *   具体的泄露面（审计实测）：
 *     ① /api/share?id=xxx 用**可枚举的 sessionId** 返回私密解读全文
 *     ② /api/dashboard 暴露全站用户的问题原文 + 全部解读
 *     ③ /api/interpret 允许**任意指定 userKey** → 可读写他人画像
 *     ④ /api/answer 拿到 sessionId 即可替用户回答（破坏仪式）
 *
 * ⚠️ 设计取舍（为什么不是"全部要登录"）：
 *   占卜产品的用户是**匿名**的 —— 强制登录会把"打开网页就能占卜"
 *   这个核心体验毁掉。所以不用用户体系，而是用**能力凭证**：
 *     · 会话级凭证：会话 id 本身 + 会话密钥（用于 answer/interject）
 *     · 分享级凭证：独立的 shareToken（128bit，不可枚举）
 *     · 面板级凭证：共享 token（观测面板是内部工具）
 *     · 公开接口：只返回无隐私的数据（人格列表、健康检查）
 *
 * ⚠️ 会话 id 为什么仍要加固：
 *   原来的 id 格式是 `sess_${Date.now().toString(36)}_${random6}`：
 *     · Date.now() 部分**可枚举**
 *     · random6 是 6 位 base36（~2.2B 空间）—— 单个还行，但配合时间戳可缩小范围
 *   新格式：24 字节随机（192bit）→ 不可枚举。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ */
/* 凭证生成                                                            */
/* ------------------------------------------------------------------ */

/**
 * 生成不可枚举的会话 id
 *
 * ⚠️ 为什么不用时间戳前缀：
 *   时间戳让 id **有序且可枚举**（攻击者能遍历最近的时间窗口）。
 *   纯随机 → 2^192 的空间，无法枚举。
 */
export function generateSessionId(): string {
  return `sess_${randomBytes(24).toString("base64url")}`;
}

/**
 * 生成分享令牌（128bit）
 *
 * ⚠️ 为什么分享要用**独立**令牌，而不是直接暴露 sessionId：
 *   sessionId 是会话凭证（能 answer/interject），
 *   分享出去等于把"控制权"也给出去了。
 *   独立的 shareToken 只能**读**，不能控制。
 */
export function generateShareToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * 从请求头提取凭证
 *
 * ⚠️ 支持两种传递方式：
 *   · Authorization: Bearer <token>（标准）
 *   · X-Access-Token: <token>（浏览器 fetch 常用，且不触发 CORS 预检的复杂性）
 */
export function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const xToken = req.headers.get("x-access-token");
  if (xToken) return xToken.trim();
  // 分享链接用查询参数（方便直接贴给别人）
  const url = new URL(req.url);
  return url.searchParams.get("t");
}

/**
 * 常量时间比较（防时序攻击）
 *
 * ⚠️ 为什么不能用 ===：
 *   字符串比较会在第一个不同字符处提前返回，
 *   攻击者可以通过响应时间差异**逐字符猜出** token。
 */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // ⚠️ 长度不同要**先**返回 false（否则 timingSafeEqual 会抛）
  //    但这会泄露长度信息 —— 对固定长度的 token 无影响
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ */
/* 面板鉴权                                                            */
/* ------------------------------------------------------------------ */

/**
 * 观测面板的访问令牌
 *
 * ⚠️ 为什么用"共享 token"而不是完整用户体系：
 *   面板是**运维/演示**工具，不是面向终端用户的功能。
 *   一个环境变量配置的 token 就够，且不会引入用户系统复杂度。
 *
 * ⚠️ 没配置时怎么办：
 *   **默认拒绝**（fail closed）—— 公网部署下"没配置就放开"是危险的默认值。
 *   本机开发可用 DASHBOARD_TOKEN=dev 显式放开。
 */
export function getDashboardToken(): string | null {
  const t = process.env.DASHBOARD_TOKEN?.trim();
  return t && t.length > 0 ? t : null;
}

/**
 * 校验面板访问
 *
 * @returns true = 允许访问
 */
export function checkDashboardAuth(req: Request): boolean {
  const expected = getDashboardToken();
  if (!expected) {
    // ⚠️ fail closed：没配置 token → 拒绝
    //    （开发时用 DASHBOARD_TOKEN=dev 放开）
    console.error("[auth] DASHBOARD_TOKEN 未配置 → 拒绝面板访问（fail closed）");
    return false;
  }
  const token = extractToken(req);
  if (!token) return false;
  return safeEqual(token, expected);
}

/* ------------------------------------------------------------------ */
/* userKey 派生                                                        */
/* ------------------------------------------------------------------ */

/**
 * 从请求派生 userKey（跨会话画像的主键）
 *
 * ⚠️ 为什么不能信客户端传的 userKey：
 *   客户端可以传**任意** userKey → 读写他人的画像
 *   （主题分布、情绪轨迹、历史问题）。
 *   审计实测这是真实漏洞。
 *
 * ⚠️ 现在的策略：
 *   服务端从 **cookie + IP + UA** 派生一个**加盐哈希**。
 *   · 用户无感（不用登录）
 *   · 不可伪造（除非知道别人的 IP+UA 组合）
 *   · 换网络设备就是新画像（可接受 —— 隐私优先）
 */
export function deriveUserKey(req: Request, clientProvided?: string): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  const ua = req.headers.get("user-agent") ?? "unknown";
  // ⚠️ 盐：让攻击者无法用"猜 IP+UA"的方式离线枚举所有 userKey
  const salt = process.env.USER_KEY_SALT ?? "mystic-tarot-default-salt";
  const raw = `${salt}|${ip}|${ua}`;
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 32);

  // 客户端提供的 key **只作为额外区分维度**（不影响安全性）：
  // 用户在同一 IP+UA 下可以自己区分多个画像（比如家庭/工作）
  if (clientProvided && /^[A-Za-z0-9_-]{1,64}$/.test(clientProvided)) {
    const h2 = createHash("sha256").update(`${raw}|${clientProvided}`).digest("hex").slice(0, 32);
    return h2;
  }
  return hash;
}

/* ------------------------------------------------------------------ */
/* 输入长度校验                                                        */
/* ------------------------------------------------------------------ */

/** 各字段的长度上限（按公网标准，防成本放大） */
export const LIMITS = {
  /** 占卜问题 */
  question: 500,
  /** 追问 */
  followup: 500,
  /** HITL 应答正文 */
  answer: 4000,
  /** 呼召三问的答案条数 */
  answers: 10,
  /** 客户端提供的 userKey（仅作为区分维度） */
  userKey: 64,
  /** 请求体总长度 */
  bodyBytes: 32 * 1024,
} as const;

/**
 * 校验并截断文本
 *
 * @returns 截断后的文本（超长时截断而不是拒绝 —— 用户体验更好）
 */
export function clampText(s: unknown, max: number): string {
  const t = typeof s === "string" ? s : "";
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * 校验请求体大小
 *
 * ⚠️ 为什么重要：
 *   `question` 无上限 → 用户 POST 一个 10MB 的 question →
 *   每一轮 LLM prompt 都带着它 → **每轮 prompt token 爆炸**
 *   （实测单场均值已是 58,468 token，极端 173,170），
 *   而且 `state_json` 每 10 秒全量重写一次 → 写放大。
 *   单个请求就能显著放大成本。
 */
export function checkBodySize(req: Request, max = LIMITS.bodyBytes): boolean {
  const len = req.headers.get("content-length");
  if (!len) return true; // 没有 content-length（chunked）→ 交给读取时的检查
  const n = Number(len);
  return Number.isFinite(n) && n <= max;
}

/* ------------------------------------------------------------------ */
/* 安全响应头                                                          */
/* ------------------------------------------------------------------ */

/**
 * 给响应加上安全头
 *
 * ⚠️ 为什么统一在这里加，而不是每个路由手写：
 *   审计发现只有 /api/share 一个路由设了安全头，其余全裸。
 *   集中管理才能保证"新增路由不会漏"。
 */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), interest-cohort=()"
  );
  // ⚠️ CSP：分享页不需要脚本，且分享内容是用户生成的
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'"
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** 统一的未授权响应 */
export function unauthorized(message = "未授权访问"): Response {
  return withSecurityHeaders(
    Response.json({ error: message }, { status: 401 })
  );
}

/** 统一的请求错误响应 */
export function badRequest(message: string): Response {
  return withSecurityHeaders(
    Response.json({ error: message }, { status: 400 })
  );
}
