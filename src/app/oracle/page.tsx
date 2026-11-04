import type { Metadata } from "next";
import OracleChat from "@/components/OracleChat";

/**
 * 问神谕 —— /oracle
 *
 * ⚠️ 竞品对标（Tarot Run 的 Oracle）：
 *   「無論是剛抽到的牌、看不懂的牌陣，還是想理清的處境，都可以直接提問」
 *   「可以追問 —— 一次解讀往往不夠。神諭會記住上下文」
 *
 * ⚠️ 为什么是**独立页面**而不是首页的一个 tab：
 *   神谕的交互模型完全不同（自由对话 + 追问，没有牌阵、没有仪式）。
 *   塞进首页会让首页的"仪式感"变脏 —— 用户进来不知道该做什么。
 *   → 独立入口 + 独立页面，各自清晰。
 */
export const metadata: Metadata = {
  title: "问神谕 · AI 塔罗对话占卜 | Mystic Tarot",
  description:
    "不必抽牌也能问。免费 AI 神谕对话：解读牌义、聊你的处境、推荐合适的占卜方式，随时追问。",
  openGraph: {
    title: "问神谕 · Mystic Tarot",
    description: "不必抽牌也能问 —— 牌义、处境、该用哪种方式。",
  },
};

export default function OraclePage() {
  return <OracleChat />;
}
