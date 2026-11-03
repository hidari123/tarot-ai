import type { NextConfig } from "next";

/**
 * 全局安全响应头（P3-⑬ · 公网部署标准）
 *
 * ⚠️ 为什么放在 next.config 而不是每个 API 路由里手写：
 *   审计实测：只有 /api/share 一个路由设了安全头，其余**全裸**。
 *   逐路由手写的问题：
 *     · 新增路由必然漏（这正是 bug 的成因）
 *     · 静态页面（HTML）也拿不到头
 *   Next 的 `headers()` 是**框架级**的 —— 声明一次，全站生效，包括页面。
 *
 * ⚠️ CSP 里的 'unsafe-inline'（style）：
 *   Next.js + Tailwind 4 会把样式内联注入，
 *   严格 CSP 需要 nonce —— 但 nonce 与静态优化（cacheComponents）冲突。
 *   权衡：script-src 'none'/'self' 是**关键**（挡 XSS 执行），
 *   style 的 unsafe-inline 风险较低（样式注入不能执行 JS）。
 *   分享页那种完全独立的 HTML 用的是更严格的 CSP（见 share 路由）。
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // ⚠️ script-src 不含 'unsafe-inline' —— 这是 CSP 挡 XSS 的核心
      //    'unsafe-eval' 只在开发模式需要（React Refresh 的热更新）
      //    生产构建必须去掉 —— 否则 CSP 的价值大打折扣。
      process.env.NODE_ENV === "production"
        ? "script-src 'self'"
        : "script-src 'self' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // ⚠️ connect-src 'self' —— 前端只能连自己的 API
      "connect-src 'self'",
      // ⚠️ frame-ancestors 'none' —— 禁止被 iframe 嵌套（点击劫持）
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; "),
  },
];

/**
 * CORS 白名单（P3-⑭）
 *
 * ⚠️ 诚实说明（**不要误读成"缺少 CORS = 不安全"**）：
 *   浏览器**默认禁止**跨域请求 —— 没有 CORS 头就是"最严格的白名单（空）"。
 *   所以"没有 CORS 配置"本身**不是漏洞**。
 *
 * ⚠️ 真正需要 CORS 的场景：
 *   前端与 API **不同域**部署时（比如前端在 CDN，API 在 api.example.com）。
 *   这时必须显式声明允许的来源。
 *
 * ⚠️ 为什么用环境变量白名单而不是 `*`：
 *   `Access-Control-Allow-Origin: *` 允许任意网站来读你的 API 响应 ——
 *   对"返回用户私密解读"的接口是**严重问题**。
 *   同源部署时根本不需要 CORS 头。
 */
const corsOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // 方向⑥：standalone 产物 —— Docker 镜像只带运行时必需文件（不用整份 node_modules）
  output: "standalone",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },

  /**
   * 全局响应头（P3-⑬）
   *
   * ⚠️ source 覆盖全部路径（含页面、静态资源、API）。
   */
  async headers() {
    const list = [];
    for (const path of ["/:path*"]) {
      list.push({ source: path, headers: securityHeaders });
      // ⚠️ CORS 只在**显式配置了白名单**时才发头。
      //    没配置 = 同源部署 = 不需要 CORS（浏览器默认拒绝跨域，最安全）。
      if (corsOrigins.length > 0) {
        list.push({
          source: path,
          headers: [
            {
              key: "Access-Control-Allow-Origin",
              value: corsOrigins.join(", "),
            },
            { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
            { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, X-Access-Token, Last-Event-ID" },
            { key: "Access-Control-Max-Age", value: "86400" },
          ],
        });
      }
    }
    return list;
  },
};

export default nextConfig;
