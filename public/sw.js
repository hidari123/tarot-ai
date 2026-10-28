/* Mystic Tarot · Service Worker
 *
 * 策略（分层）：
 *  - 导航请求（HTML）：network-first → 失败回退缓存的 shell（离线可打开首页）
 *  - 静态资源（js/css/png/woff2）：stale-while-revalidate（秒开 + 后台更新）
 *  - /api/* 与 SSE（/api/interpret）：**永不缓存** —— 占卜是实时推理，
 *    缓存 SSE 会导致"读到上一次的占卜结果"，是严重正确性 bug
 *
 * 版本号变更即全量清缓存（改完资源记得 bump CACHE_VERSION）。
 */

const CACHE_VERSION = "v1";
const STATIC_CACHE = `mystic-static-${CACHE_VERSION}`;
const PAGE_CACHE = `mystic-pages-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-64.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ⚠️ API 与流式响应永不缓存
  if (url.pathname.startsWith("/api/")) return;

  // 导航请求：network-first，离线回退首页
  if (req.mode === "navigate") {
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

  // 静态资源：stale-while-revalidate
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
