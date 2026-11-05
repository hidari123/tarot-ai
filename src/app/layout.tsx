import type { Metadata, Viewport } from "next";
import "@fontsource/cinzel/400.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/ma-shan-zheng/400.css";
/**
 * ⚠️ 中文衬线体（2026-11-05 视觉重设计 · 第 1 批）
 *
 * ⚠️ 为什么需要它：
 *   之前正文全是**系统默认无衬线**（--font-geist-sans 其实没被加载），
 *   这是"廉价感"最大的来源 —— 灵性/占卜内容的排版应该用衬线体（有书籍感）。
 *
 * ⚠️ 只引入 **chinese-simplified** 子集（不是全量 1632 个分片）：
 *   全量包会把每个 unicode 区段都打进 CSS → 构建产物体积暴涨。
 *   chinese-simplified 子集是**单个字体文件**（体积可控），
 *   且我们只写简体中文。
 *
 * ⚠️ 字重只取 400 与 600：
 *   解读正文 400（可读性最好）、标题 600（有重量感）。
 *   700+ 对衬线体在深色背景上容易显脏。
 */
import "@fontsource/noto-serif-sc/chinese-simplified-400.css";
import "@fontsource/noto-serif-sc/chinese-simplified-600.css";
import "./globals.css";
import PwaRegister from "@/components/PwaRegister";
import MotionProvider from "@/components/MotionProvider";

export const metadata: Metadata = {
  title: "Mystic Tarot · AI 塔罗占卜",
  description: "倾听星辰的低语，窥探命运的轨迹 —— AI Agent + RAG 驱动的塔罗占卜",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Mystic Tarot",
  },
  icons: {
    icon: [
      { url: "/icons/icon-64.png", sizes: "64x64", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#7c3aed",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    /**
     * ⚠️⚠️ 高度链路（2026-11-04 修"全屏却有右侧滚动条"）：
     *
     *   原来的组合是：
     *     <html className="h-full">          → html 高度 = 视口高（**不含滚动条**）
     *     <body className="min-h-full">      → body 最小高度 = html 高 = 视口高
     *     <main className="min-h-screen">    → 100vh（**含滚动条高度**）
     *
     *   CSS 里 `100vh` **包含滚动条的高度**，而 `h-full` 用的是**视口高（不含滚动条）**。
     *   两者叠加 → 内容比视口高出一个滚动条的高度 → **右侧出现滚动条**。
     *   而 `<main>` 上有 `overflow-hidden` → 内容被裁，但**页面本身仍可滚**。
     *
     *   修法：主体改用 `min-h-[100dvh]`（dvh = dynamic viewport height，
     *   **不含滚动条**，且移动端地址栏收放/软键盘时自适应）。
     *   → 见 `src/app/page.tsx` 的 <main>。
     *
     *   ⚠️ 这里把 body 的 `min-h-full` 去掉了 —— 它是冗余的：
     *   <main> 自己就是 `min-h-[100dvh]`，body 再叠一层只会加剧溢出。
     */
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex flex-col">
        {/* ⚠️ P2-⑳：动效降级包在最外层 —— framer-motion 的 JS 动画
            也跟随系统的 prefers-reduced-motion 设置 */}
        <MotionProvider>
          {children}
        </MotionProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
