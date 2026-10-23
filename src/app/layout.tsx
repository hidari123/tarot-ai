import type { Metadata } from "next";
import "@fontsource/cinzel/400.css";
import "@fontsource/cinzel/600.css";
import "@fontsource/ma-shan-zheng/400.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mystic Tarot · AI 塔罗占卜",
  description: "倾听星辰的低语，窥探命运的轨迹 —— AI Agent + RAG 驱动的塔罗占卜",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
