"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/icons";

/**
 * 路由级错误边界
 *
 * ⚠️⚠️ 为什么必须有这个文件（第二轮优化分析 2026-11 ⑥）：
 *   改造前 `src/` 下**完全没有**错误边界（grep 确认无 error.tsx / global-error.tsx /
 *   ErrorBoundary）。后果是**最严重的 UX 故障**：
 *     · 任意组件抛错 → React 卸载整棵树 → **整页白屏**
 *     · 更糟的是：**正在跑的占卜全部作废**（一场 ≈ ¥0.58 的 LLM 成本）
 *     · 用户唯一的出路是刷新页面
 *   换句话说：一个偶发的客户端异常 = 一次真实的经济损失 + 一次体验崩塌。
 *
 * ⚠️ 为什么"路由级"就够用了：
 *   · `error.tsx` 捕获**该路由段内**的错误（含客户端组件的渲染错误）
 *   · `global-error.tsx` 捕获**根布局自身**的错误（更极端的情况）
 *   两者配合 = 任何异常都有兜底，不会出现纯白屏。
 *
 * ⚠️ 为什么不能 `throw` 让它继续冒泡：
 *   error.tsx 自己抛错会升级到 global-error.tsx；
 *   但那样用户就什么都不剩了。所以这里**必须提供一个可操作的出口**
 *   （重试 / 回首页），而不是只显示一句"出错了"。
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // ⚠️ 只记录，不弹窗 —— 弹窗会打断用户，而且错误信息不该暴露给终端用户。
    //    digest 是 Next.js 给出的服务端错误标识，用于在日志里定位。
    console.error("[route-error]", error.message, error.digest ?? "");
  }, [error]);

  return (
    <main className="min-h-[100dvh] flex items-center justify-center px-6 relative overflow-hidden">
      {/* 背景氛围（与首页同调，避免"系统错误页"的突兀感） */}
      <div
        className="absolute inset-0 opacity-30 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 50% 40%, rgba(124,58,237,0.18), transparent 60%)",
        }}
      />

      <div className="relative z-10 flex flex-col items-center gap-5 text-center max-w-md">
        {/* 图标 */}
        <div className="w-16 h-16 rounded-full border border-purple-400/30 bg-purple-950/40 flex items-center justify-center">
          <Icon name="crystal" size={26} className="text-purple-200/80" />
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-xl tracking-[0.2em] text-purple-100/90">
            星象扰动，占卜中断
          </h1>
          <p className="text-sm leading-relaxed text-purple-200/50">
            牌阵被意外打断了。已完成的解读不会丢失，
            <br />
            你可以重新开始一次占卜。
          </p>
        </div>

        {/* 操作出口 */}
        <div className="flex items-center gap-3 mt-1">
          <button
            type="button"
            onClick={() => reset()}
            className="px-5 py-2 rounded-full border border-purple-400/40 bg-purple-500/15 text-purple-100/90 text-sm tracking-[0.15em] hover:bg-purple-500/25 hover:border-purple-400/60 transition-colors"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => {
              // ⚠️ 用 router 而不是 window.location.href ——
              //   后者会触发整页刷新（丢掉所有客户端状态），且 Next.js 会警告。
              router.push("/");
            }}
            className="px-5 py-2 rounded-full border border-white/10 bg-white/5 text-white/60 text-sm tracking-[0.15em] hover:text-white/85 hover:bg-white/10 transition-colors"
          >
            回到首页
          </button>
        </div>

        {/* 诊断信息（折叠，默认不显眼但保留排查入口） */}
        {error.digest && (
          <details className="mt-2 text-[11px] text-white/25 max-w-full">
            <summary className="cursor-pointer hover:text-white/40 transition-colors">
              技术详情
            </summary>
            <p className="mt-1.5 font-mono break-all">
              {error.message || "未知错误"}
              {error.digest ? ` (${error.digest})` : ""}
            </p>
          </details>
        )}
      </div>
    </main>
  );
}
