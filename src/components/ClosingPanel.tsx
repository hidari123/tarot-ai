"use client";

import { motion } from "framer-motion";

/**
 * 收束落点卡片
 *
 * ⚠️⚠️ 为什么需要它（用户实测报告："综合与收束那里，我每次回答完问题，
 *   都是停在那里了…不要让用户停在那里"）：
 *   后端流程本身是完整的（实测：ask_user×10 → done×1），
 *   但用户视角是"我说完了 → 界面静止 → 不知道还能干嘛"。
 *   → 这张卡片给这一场一个**落点**，并把用户**接回对话**。
 *
 * ⚠️ 四个出口对应现有的能力（不新增后端接口）：
 *   · 我想再问一句 → 展开追问输入框（走 /api/interpret + followup）
 *   · 保存解读卡片 → 现有的 ShareCardButton
 *   · 换个占卜师聊聊 → 现有的 persona_suggest
 *   · 重新开始 → 现有的 restart
 *
 * ⚠️ canFollowup 的作用：
 *   会话在内存里被逐出（30 分钟未活跃）后，追问会 410。
 *   → 卡片必须**知道**追问还能不能用，不能给一个必然失败的按钮。
 *   → 不可追问时，"我想再问一句"降级为"重新开始"（不假装能行）。
 */
export default function ClosingPanel({
  canFollowup,
  onAskAgain,
  onShare,
  onSwitchPersona,
  onRestart,
  /** 人格切换建议（来自 persona_suggest 事件） */
  personaSuggest,
}: {
  /** 追问是否可用（会话还在内存里） */
  canFollowup: boolean;
  /** 点"我想再问一句" */
  onAskAgain: () => void;
  /** 点"保存解读卡片" */
  onShare: () => void;
  /** 点"换个占卜师聊聊" */
  onSwitchPersona?: () => void;
  /** 点"重新开始" */
  onRestart: () => void;
  personaSuggest?: { name: string; emoji?: string; reason?: string } | null;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className="w-full max-w-2xl mt-6 rounded-2xl border border-purple-400/25 bg-gradient-to-b from-purple-950/30 to-[#0d0819]/60 backdrop-blur-md px-5 py-5"
    >
      {/* 标题 */}
      <div className="flex items-center gap-2.5 mb-3">
        <span className="text-lg text-amber-200/90 rune-breathe">✦</span>
        <span
          className="text-xs tracking-[0.3em] text-amber-200/80"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        >
          命运的卷轴已合上
        </span>
      </div>

      {/* 人格切换建议（如果有）—— 文案刻意做轻，不说教 */}
      {personaSuggest && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-950/10 px-3.5 py-2.5">
          <p className="text-xs text-amber-100/80 leading-relaxed">
            <span className="mr-1.5">{personaSuggest.emoji ?? "✧"}</span>
            {personaSuggest.reason ?? "要不要换个人聊聊？"}
          </p>
          {onSwitchPersona && (
            <button
              onClick={onSwitchPersona}
              className="mt-2 px-3 py-1.5 rounded-lg border border-amber-400/35 text-amber-100/90 text-xs hover:bg-amber-900/25 transition-all"
            >
              找 {personaSuggest.name} 聊聊
            </button>
          )}
        </div>
      )}

      {/* 四个出口 */}
      <div className="grid grid-cols-2 gap-2.5">
        <button
          onClick={onAskAgain}
          disabled={!canFollowup}
          title={canFollowup ? "继续追问占卜师" : "这场对话已经结束（会话保留 30 分钟），可以重新开始一场"}
          className={`px-4 py-2.5 rounded-xl text-sm transition-all border ${
            canFollowup
              ? "border-purple-400/45 text-purple-100 bg-purple-900/25 hover:bg-purple-800/35 hover:border-purple-300/60"
              : "border-white/10 text-purple-300/35 bg-white/[0.02] cursor-not-allowed"
          }`}
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        >
          {canFollowup ? "我想再问一句" : "再问一句（需重新开始）"}
        </button>

        <button
          onClick={onShare}
          className="px-4 py-2.5 rounded-xl text-sm transition-all border border-purple-400/35 text-purple-100/90 bg-purple-900/15 hover:bg-purple-800/30 hover:border-purple-300/55"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        >
          保存解读卡片
        </button>

        <button
          onClick={onRestart}
          className="px-4 py-2.5 rounded-xl text-sm transition-all border border-purple-400/25 text-purple-200/80 bg-purple-900/10 hover:bg-purple-800/25"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        >
          重新开始
        </button>

        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="px-4 py-2.5 rounded-xl text-sm transition-all border border-purple-400/25 text-purple-200/80 bg-purple-900/10 hover:bg-purple-800/25"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        >
          回到牌阵
        </button>
      </div>

      {/* ⚠️ 追问不可用时的说明（诚实告知，不让用户白点） */}
      {!canFollowup && (
        <p className="mt-3 text-[11px] text-purple-400/40 leading-relaxed">
          这场对话的对话内容已经封存（占卜师的记忆保留 30 分钟）。
          重新开始一场，仍然可以接着问。
        </p>
      )}
    </motion.div>
  );
}
