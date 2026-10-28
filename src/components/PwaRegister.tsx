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
 *  3. SW 内部对 /api/* 与 SSE 流永不缓存（见 public/sw.js 注释）
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // 开发环境不注册：SW 缓存会掩盖热更新，导致"改了代码没生效"的假象
    if (process.env.NODE_ENV !== "production") return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          // 有新版本时静默更新（用户下次打开即生效）
          reg.addEventListener("updatefound", () => {
            const sw = reg.installing;
            if (!sw) return;
            sw.addEventListener("statechange", () => {
              if (sw.state === "installed" && navigator.serviceWorker.controller) {
                console.info("[pwa] 新版本已就绪，下次打开生效");
              }
            });
          });
        })
        .catch((e) => console.warn("[pwa] Service Worker 注册失败（不影响使用）", e));
    };

    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
