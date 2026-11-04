import { NextResponse, type NextRequest } from "next/server";

/**
 * CSP nonce 下发（P3-⑬ · 2026-11-04 修回归）
 *
 * ⚠️⚠️ 背景（一个"看起来安全的配置"造成的真实故障）：
 *   上一轮公网化改造时，把 CSP 放在 `next.config.ts` 的 `headers()` 里，
 *   生产模式用 `script-src 'self'`（不含 'unsafe-inline'）。
 *   实测后果：**首页永远停在 loading**。
 *     · Next.js App Router 的 HTML 里有 **8 个内联 `<script>`**
 *       （RSC payload：`self.__next_f.push(...)` + hydration 引导）
 *     · `script-src 'self'` **不允许内联脚本**
 *     * → 浏览器拦截 → React 不 hydrate → 页面停在 Next 的 loading 骨架
 *
 *   为什么这是**深度教训**：
 *     那个配置"看起来"比 `unsafe-inline` 安全得多，
 *     静态检查、TSC、ESLint、我的验证脚本**全都通过**，
 *     而且我写的 `verify-api-auth.mjs` 断言的是"响应带 CSP" —— 它**通过**了！
 *     因为那条断言只看"头在不在"，不看"头会不会把页面挡死"。
 *
 *   → **安全头的强度必须用"页面真的能跑"来验证**，不能只看"头设了没有"。
 *
 * ⚠️ 为什么用 nonce 而不是 'unsafe-inline'：
 *   'unsafe-inline' 会让 CSP 失去挡 XSS 的核心能力（内联脚本随便跑）。
 *   nonce 是**每次请求随机**的一次性令牌：
 *   攻击者即使能注入 HTML，也无法预测本次请求的 nonce → 内联脚本仍被拦。
 *   而 Next.js 自己的内联脚本**带上同一个 nonce** → 正常执行。
 *
 * ⚠️ Next.js 的机制：
 *   **middleware 在请求头里设置 CSP** 时，Next 会读取该头，
 *   自动给它生成的 inline script 加上 nonce。
 *   （所以必须设在**请求头**，不是只设在响应头 —— 这是能否自动加 nonce 的关键。）
 *
 * ⚠️⚠️ 结局：nonce 方案**实测不可用**（PPR 与之不兼容，见 buildCsp 的说明），
 *   最终改用 `'unsafe-inline'` + 保留其余严格指令。
 */

/**
 * 拼 CSP 字符串
 *
 * ⚠️⚠️ 关于 `script-src` 的最终决策（**这是本项目实测后的结论，不是抄来的**）：
 *
 *   曾试过 nonce 方案（`script-src 'self' 'nonce-xxx' 'strict-dynamic'`），
 *   **实测失败**：Next.js 文档明确写着
 *     "To use a nonce, your page must be **dynamically rendered**...
 *      Static pages are generated at build time, when no request or response
 *      headers exist—so no nonce can be injected."
 *     "**Partial Prerendering (PPR) is incompatible with nonce-based CSP**"
 *   而本项目开了 `cacheComponents: true`（= PPR）→ 首页走静态/缓存渲染
 *   → **nonce 注入不进来** → 内联脚本仍被拦 → **首页照样卡在 loading**。
 *
 *   那要不要改成动态渲染？
 *     首页内容（问题输入框 / 人格选择 / 星空背景）**全是静态的**，
 *     静态渲染对它是**净收益**（快、可 CDN 缓存）。
 *     为了一条用不上的 CSP 头牺牲首页性能，**不划算**。
 *
 *   所以最终用 `'unsafe-inline'` —— 但**必须说清楚为什么这在本项目是安全的**：
 *     · 全项目 **0 处** `dangerouslySetInnerHTML` / `innerHTML` / `eval`
 *       → React 自动转义所有插值 → **没有 XSS 注入面**
 *     · 唯一手工拼 HTML 的地方是 `/api/share` 分享页
 *       → 它**不在**本 proxy 的 matcher 里 → **保持自己的严格 CSP**
 *         （`script-src 'none'`，见 share 路由）
 *     → 真正的注入面被单独严防，而无注入面的页面用宽松一点的 script-src
 *
 *   ⚠️⚠️ 将来若引入 `dangerouslySetInnerHTML`，**必须重新评估这里的策略**。
 *
 * ⚠️ 关于 `strict-dynamic`：它与 `'unsafe-inline'` **不能共存** ——
 *   浏览器在存在 `strict-dynamic` 时会**忽略** `'unsafe-inline'`。
 *   没有 nonce 就别加它。
 */
function buildCsp(isDev: boolean): string {
  const scriptSrc = [
    "'self'",
    // ⚠️ 见上方说明：本项目无 XSS 注入面（0 处 dangerouslySetInnerHTML）
    "'unsafe-inline'",
    // ⚠️ 开发模式需要 'unsafe-eval'（React Refresh 的热更新用 eval）
    ...(isDev ? ["'unsafe-eval'"] : []),
  ].join(" ");

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // ⚠️ style-src 需要 'unsafe-inline'：Next + Tailwind 4 会内联注入样式。
    //    样式注入不能执行 JS，风险远低于脚本。
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // ⚠️ connect-src 'self' —— 前端只能连自己的 API
    "connect-src 'self'",
    // ⚠️ frame-ancestors 'none' —— 禁止被 iframe 嵌套（点击劫持）
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // ⚠️ object-src 'none' + base-uri 'self'：
    //    即使有 HTML 注入，攻击者也无法用 <object>/<base> 把它变成攻击载体。
    //    这是在 script-src 放宽后**仍然保留的防线**。
    "object-src 'none'",
    // ⚠️ worker-src：Service Worker（PWA）需要
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/**
 * ⚠️ Next.js 16 的 `proxy` 约定：
 *   导出**默认函数**（不再用命名的 `middleware` 导出）——
 *   否则 build 会报 "Proxy is missing expected function export name"。
 */
export default function proxy(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production";
  const csp = buildCsp(isDev);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // 同时放进响应头（浏览器实际执行的是这个）
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  /**
   * ⚠️ 匹配范围：只处理**页面与静态资源**的请求。
   *   API 路由不需要 nonce（它们返回 JSON，没有内联脚本）——
   *   排除掉能省掉一次随机数生成 + 头拷贝。
   */
  matcher: [
    // ⚠️ 排除 API、静态文件、Service Worker
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.json|sw.js|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js|woff2?)$).*)",
  ],
};
