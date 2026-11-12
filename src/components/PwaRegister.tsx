"use client";

import { useEffect } from "react";

/**
 * 方向⑥：PWA 注册（Service Worker + 离线壳 + 安装提示）
 *
 * 为什么单独一个组件：Service Worker 只能在浏览器端注册，
 * 且必须放在客户端边界内（layout 是服务端组件）。
 *
 * 关键约束（写在代码里防止后人踩坑）：
 *  1. **只在生产构建注册** —— dev 下 SW 会缓存旧代码，改代码看不到效果
 *  2. **注册失败不阻塞页面** —— 离线能力是增强，不是前提
 *  3. SW 内部对 /api/* 与 SSE 流永不缓存（见 src/sw/sw.js 注释）
 *
 * ⚠️⚠️ 2026-11-09 修正（用户反馈「前端页面怎么变成早期版本的了」）：
 *   注册路径的 SW 文件名**带构建版本号**（`sw.v<hash>.js`）。
 *
 *   ⚠️ 为什么必须带版本号：
 *     `public/` 下的文件在 Next.js 构建时**原样拷贝，不参与内容哈希**
 *     → URL 永远是 `/sw.js`
 *     → 浏览器会一直用 HTTP 缓存里的旧 SW 文件
 *     → 旧 SW 里的 CACHE_VERSION 也是旧的 → 旧 chunk 永远留在缓存
 *     → 用户看到的就是"早期版本"
 *   → 文件名带 hash → URL 变了 → 浏览器强制拉新的 SW。
 *   → 路径由 `scripts/dev/bump-sw-version.mjs` 在构建后注入。
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // 开发环境不注册：SW 缓存会掩盖热更新，导致"改了代码没生效"的假象
    if (process.env.NODE_ENV !== "production") return;

    /**
     * ⚠️⚠️⚠️ 本地预览开关（2026-11-12）
     *
     * ⚠️ 用户反馈：「我本地如何看到最新效果 不用部署的情况下 部署目前一直有缓存」
     *
     * ⚠️ 问题的本质：
     *   `next start` 跑的是 **production 模式** → SW 会注册 → 缓存接管
     *   → 本地每次构建后看到的还是**缓存里的旧页面**
     *   → 用户以为"改了没生效"，实际上是 SW 在骗人
     *
     * ⚠️ 解法：设 `NEXT_PUBLIC_DISABLE_SW=1` → 本地完全不注册 SW
     *   → 每次刷新都是最新构建 ✅
     *   → 部署环境不设这个变量 → SW 正常注册（离线能力保留）✅
     *
     * ⚠️ 为什么用 NEXT_PUBLIC_ 前缀：
     *   这个值要**编译进客户端 bundle**（在浏览器里判断）
     *   → 必须是 NEXT_PUBLIC_ 前缀才能被客户端读到
     */
    /**
     * ⚠️⚠️⚠️ 为什么**不能**用 `process.env.NEXT_PUBLIC_DISABLE_SW`（实测踩坑）：
     *   Next.js 16 对 `process.env.NEXT_PUBLIC_*` 做**编译期常量替换**
     *   → 实测编译产物里变成了 `"u" > typeof caches`（"u" 是 undefined 的内部常量）
     *   → 判断永远为 false → **开关完全失效** ❌
     *   ⚠️ 原因：这个变量**没有在任何地方被真正读取**（只在比较里出现）
     *   → Next.js 的 define 插件没把它注入 → 替换成了 undefined
     *
     * ⚠️ 可靠做法：读 `document.documentElement.dataset`（运行时属性，不受编译期替换影响）
     */
    const disableSw =
      typeof document !== "undefined" &&
      document.documentElement.dataset.disableSw === "true";

    if (disableSw) {
      // ⚠️ 同时**注销已存在的 SW** + 清缓存
      //   → 否则之前注册的 SW 还会继续接管（实测：SW 注销了但缓存还在）
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
      if (typeof caches !== "undefined") {
        caches
          .keys()
          .then((keys) => keys.forEach((k) => caches.delete(k)))
          .catch(() => undefined);
      }
      return;
    }

    /**
     * ⚠️ SW 文件名带版本号（构建后由 bump-sw-version.mjs 注入）
     * ⚠️ 为什么要 fallback：
     *   万一注入脚本没跑（本地手动改代码、CI 缓存等），
     *   至少还有 /sw.js 可用 —— 只是少了"强制更新"能力。
     */
    const SW_URL = process.env.NEXT_PUBLIC_SW_URL ?? "/sw.js";

    const register = () => {
      navigator.serviceWorker
        .register(SW_URL, { scope: "/" })
        .then((reg) => {
          // ⚠️⚠️ 有新版本时**立即接管 + 通知页面刷新**
          //   旧行为：只 console.info("下次打开生效")
          //   → 用户不手动刷新就一直看旧版本（用户反馈的正是这个）
          reg.addEventListener("updatefound", () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener("statechange", () => {
              if (sw.state === "installed" && navigator.serviceWorker.controller) {
                console.info("[pwa] 新版本已就绪，正在刷新");
                // 让新 SW 立即接管（不等所有标签页关闭）
                sw.postMessage({ type: "SKIP_WAITING" });
              }
            });
          });
        })
        .catch((e) => console.warn("[pwa] Service Worker 注册失败（不影响使用）", e));

      /**
       * ⚠️ 新 SW 接管后，主动刷新页面一次
       * ⚠️ 为什么需要：
       *   SW 更新只影响**下一次**的请求。
       *   当前页面已经加载了旧的 HTML/JS → 不刷新就看不到新版本。
       *   → 收到 SW_UPDATED 消息 → reload 一次。
       * ⚠️ 用 sessionStorage 打标记，避免"刷新 → 再次触发更新 → 无限刷新"：
       *   只有真正发生过一次刷新后才不再自动 reload。
       */
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "SW_UPDATED") {
          const KEY = "pwa:reloaded-for-sw";
          if (sessionStorage.getItem(KEY)) return; // 已经刷新过一次了
          sessionStorage.setItem(KEY, "1");
          window.location.reload();
        }
      });
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
