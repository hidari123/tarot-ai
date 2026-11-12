/* Mystic Tarot · Service Worker
 *
 * ⚠️⚠️ 2026-11-09 重写（用户反馈「前端页面怎么变成早期版本的了」）：
 *
 * 【旧版的三个 bug】
 *
 * ① **页面被当静态资源缓存**（这是"看起来像早期版本"的直接原因）
 *    旧逻辑只按 `req.mode === "navigate"` 判断"这是页面"：
 *      · 用户**直接输入网址 / 刷新** → mode = navigate → network-first ✅ 最新
 *      · 用户**从站内链接点进去** → mode = navigate 之外 → 落到 stale-while-revalidate
 *        → **返回缓存里的旧 HTML** ❌
 *    → 用户体验就是"从首页点进运势页，看到的是老版本"。
 *
 * ② **CACHE_VERSION 永远是 "v1"**
 *    每次构建后 activate 的清理逻辑是"删掉名字不等于当前缓存名的所有缓存"
 *    → 版本不变 → 旧 chunk 永远留着 → 旧 JS 一直被 stale-while-revalidate 返回。
 *
 * ③ **sw.js 本身走 HTTP 缓存**
 *    public/ 下的文件不参与 Next.js 内容哈希 → URL 永远是 /sw.js
 *    → 浏览器可能一直用旧的 SW 文件。
 *
 * 【新版的修法】
 *
 * ① **用 Accept 头判断"是不是 HTML 页面"**，而不是只看 mode
 *    → 站内跳转的页面请求也走 network-first → 永远是最新
 *
 * ② **CACHE_VERSION 由构建脚本注入**（scripts/dev/bump-sw-version.mjs）
 *    → 每次构建 = 新缓存名 → activate 时旧缓存全清
 *
 * ③ **sw.js 文件名带版本号**（sw.v<hash>.js）
 *    → URL 变了 → 浏览器强制拉新 SW
 *    → 同时保留 /sw.js 兜底（老客户端）
 *
 * ④ **新 SW 装好后主动 skipWaiting + 通知页面刷新**
 *    → 用户不需要手动 Ctrl+F5
 *
 * 策略（分层）：
 *  - HTML 页面（含站内跳转）：network-first → 失败回退缓存
 *  - 静态资源（js/css/png/woff2）：stale-while-revalidate（秒开 + 后台更新）
 *  - /api/* 与 SSE（/api/interpret）：**永不缓存** —— 占卜是实时推理，
 *    缓存 SSE 会导致"读到上一次的占卜结果"，是严重正确性 bug
 */

const CACHE_VERSION = "__CACHE_VERSION__";
const STATIC_CACHE = `mystic-static-${CACHE_VERSION}`;
const PAGE_CACHE = `mystic-pages-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-64.png",
  "/icons/icon-maskable-512.png",
];

/**
 * ⚠️ 判断"这是不是一个 HTML 页面请求"
 *
 * ⚠️ 为什么不能只看 `req.mode === "navigate"`：
 *   · mode = navigate 只在"用户直接输入网址 / 刷新 / 前进后退"时成立
 *   · 站内 <a> 跳转、prefetch、SSR 内的资源预取 → mode 不是 navigate
 *   → 这些页面请求会落到 stale-while-revalidate → 返回旧 HTML
 *
 * ⚠️ 为什么用 Accept 头判断：
 *   浏览器导航到页面的请求，`Accept` 一定包含 `text/html`
 *   → 这是判断"用户想要一个 HTML 文档"最可靠的信号。
 */
function isHtmlRequest(req) {
  if (req.mode === "navigate") return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS).catch(() => undefined))
      // ⚠️ 立即接管：不等所有标签页关闭（否则用户要手动刷新才看到新版本）
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          // ⚠️ 因为 CACHE_VERSION 每次构建都变，
          //   所以"名字不等于当前两个缓存"的**全部**都会被清掉
          //   → 旧版本的老 chunk 不会残留
          keys
            .filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
      // ⚠️ 通知所有页面：新 SW 已接管 → 让页面刷新一次拿新资源
      .then(() =>
        self.clients.matchAll({ type: "window" }).then((clients) => {
          for (const c of clients) c.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION });
        })
      )
  );
});

self.addEventListener("message", (event) => {
  // ⚠️ 页面收到 SW_UPDATED 后应刷新（见 PwaRegister.tsx）
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ⚠️ API 与流式响应永不缓存
  if (url.pathname.startsWith("/api/")) return;

  /**
   * ⚠️⚠️⚠️ **SW 自己必须绕过缓存**（2026-11-12 修正，用户反馈「页面跟截图不一样」）
   *
   * ⚠️ 问题的根源（实测）：
   *   · 浏览器请求 `/sw.js` 来检查 SW 是否有更新
   *   · 但这个请求**也会经过本 SW 的 fetch 事件**
   *   · 而 `/sw.js` 不在 `/api/` 下、Accept 也不是 text/html
   *   → 落到下面的「静态资源 stale-while-revalidate」分支
   *   → **先返回缓存里的旧 SW 文件** ❌
   *   → 浏览器拿到的还是旧 SW → 永远不更新
   *   → 旧 SW 的 CACHE_VERSION 永远是旧值 → 旧 chunk 永远留着
   *   → **用户看到的永远是两个多月前的页面**
   *
   * ⚠️ 修法：SW 脚本请求**直接走网络**，不碰缓存
   *   → 浏览器每次都能拿到最新 SW → 触发 update → activate 清旧缓存 ✅
   */
  if (url.pathname === "/sw.js" || url.pathname.startsWith("/sw.v")) {
    event.respondWith(fetch(req, { cache: "no-cache" }));
    return;
  }

  // ── HTML 页面：network-first（修正 bug ①）──
  if (isHtmlRequest(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGE_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
    );
    return;
  }

  // ── 静态资源：stale-while-revalidate ──
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
