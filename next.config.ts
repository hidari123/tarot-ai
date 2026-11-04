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
 * ⚠️⚠️ CSP 为什么不放在这里（**2026-11-04 修的回归**）：
 *   原来这里设了 `script-src 'self'`（生产模式）。
 *   实测后果：**首页永远停在 loading** ——
 *     · Next.js App Router 的 HTML 里有 **8 个内联 `<script>`**
 *       （RSC payload：`self.__next_f.push(...)`）
 *     · `script-src 'self'` **不允许内联脚本**（没有 'unsafe-inline'）
 *     * → 浏览器拦截这些脚本 → React 不 hydrate
 *     * → 页面永远显示 Next 的 loading 骨架
 *   这是**上一轮改造引入的真实回归** —— 而且是"看起来安全的配置"造成的，
 *   正好印证了那条原则：**安全头的强度要用实测验证，不能凭直觉**。
 *
 *   修法：CSP 改由 `src/middleware.ts` 用 **nonce** 方案下发
 *   （Next.js 官方推荐路径 —— middleware 设置 CSP 请求头时，
 *    Next 会自动给它自己的内联脚本加上同一个 nonce）。
 *   本文件保留**其余**安全头（它们不含 script-src，不影响脚本执行）。
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
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
