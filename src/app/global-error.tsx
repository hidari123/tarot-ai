"use client";

import { useEffect } from "react";

/**
 * 根级错误边界
 *
 * ⚠️ 什么时候才会走到这里：
 *   `error.tsx`（路由级）覆盖了**该路由段内**的所有错误；
 *   但如果**根布局本身**（html/body）渲染时抛错，路由级边界也救不了 ——
 *   这时 React 会卸载整个文档，页面变成**纯白**（连样式都没有）。
 *   `global-error.tsx` 是最后一道防线。
 *
 * ⚠️⚠️ 关键约束：**必须自己渲染 <html> 和 <body>**。
 *   这是 Next.js App Router 的硬性要求 ——
 *   global-error 替换的是**整个文档**，不是文档里的一个子树。
 *   少了 html/body 标签，React 会报"文档结构无效"。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error.message, error.digest ?? "");
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0a14",
          color: "#e9d5ff",
          fontFamily:
            "'Ma Shan Zheng', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "20px",
            textAlign: "center",
            padding: "24px",
            maxWidth: "420px",
          }}
        >
          <h1 style={{ fontSize: "20px", letterSpacing: "0.2em", margin: 0 }}>
            星象扰动，占卜中断
          </h1>
          <p style={{ fontSize: "13px", lineHeight: 1.8, opacity: 0.55, margin: 0 }}>
            页面遇到了一个意外错误。已完成的解读保存在服务端，
            <br />
            重新加载即可继续。
          </p>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                padding: "9px 20px",
                borderRadius: "9999px",
                border: "1px solid rgba(168,85,247,0.45)",
                background: "rgba(124,58,237,0.18)",
                color: "#e9d5ff",
                fontSize: "13px",
                letterSpacing: "0.15em",
                cursor: "pointer",
              }}
            >
              重试
            </button>
            <button
              type="button"
              onClick={() => {
                // ⚠️ 这里**必须**用 window.location.href，不能用 useRouter().push()：
                //   global-error 替换的是**整个文档**，不在 Router 上下文里
                //   （useRouter 在这里会抛 "invariant expected app router to be mounted"）。
                //   Next.js 的 lint 规则不覆盖这个场景 → 显式豁免。
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.href = "/";
              }}
              style={{
                padding: "9px 20px",
                borderRadius: "9999px",
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.05)",
                color: "rgba(255,255,255,0.7)",
                fontSize: "13px",
                letterSpacing: "0.15em",
                cursor: "pointer",
              }}
            >
              回到首页
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
