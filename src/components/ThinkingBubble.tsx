"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";

/**
 * 占卜师"思考中"气泡
 *
 * ⚠️⚠️ 为什么要这个（用户诉求："大模型在思考的时候可以给一些动画过渡，
 *   不要让用户感知到等的太慢"）：
 *   之前等待期的呈现只有一个闪烁的 `▍`（typing-cursor），
 *   而它**只在占卜师已经开始说话时**才有 —— 也就是说
 *   **"模型正在生成第一个 token"的那几秒到几十秒，界面是完全静止的**。
 *   静止 = 用户以为死了 = 去刷新。
 *
 * ⚠️ 这个气泡解决三件事：
 *   ① **在场感**：占卜师"在那里"，不是在等一个进度条
 *   ② **可预期的等待**：给出占卜师口吻的短句 → 用户知道发生了什么
 *   ③ **不暴露内部实现**：短句里绝不能出现"模型/限流/请求"等术语
 *
 * ⚠️ 短句要**轮换**而不是固定 —— 固定文案重复出现会立刻显得很假。
 *   这里按"轮次索引 + 时间"取不同的一句。
 */

/** 各阶段的短句池（占卜师口吻，绝不含技术术语） */
const PHRASES: Record<string, string[]> = {
  default: [
    "让我再看看你写下的这件事…",
    "稍等，我在对照典籍里的说法…",
    "有几个细节想再确认一下…",
    "正在把牌面的话连成一条线…",
    "我在想这一张该怎么落…",
    "再给我一点时间…",
  ],
  contract: [
    "让我先把你写下的这件事接住…",
    "这一场占卜的边界，我想清楚再开始…",
    "正在把你的问题收进这一场仪式里…",
  ],
  invocation: [
    "这三个问题…我再掂量掂量。",
    "呼召已起，我在等它们自己浮上来…",
    "正在为你问出该问的那三句…",
  ],
  card_selection: [
    "牌已经洗好了…你选吧，不急。",
    "我看着你选…选哪张都是有缘分的。",
    "别急，看哪张顺眼就点哪张。",
  ],
  per_card: [
    "这张牌有点意思…让我确认一下它的位置。",
    "我先看看这张在你这儿意味着什么…",
    "正在对照这张牌的正面与逆位…",
    "让我把这一张讲透一点…",
  ],
  synthesis: [
    "三张牌要串成一句话了，别急…",
    "我在找它们之间那条看不见的线…",
    "快了，快说完了…",
  ],
  closing: [
    "让我把最后这一段收好…",
    "我在给这场占卜画个句号…",
    "最后确认一下，然后交给你。",
  ],
};

/** 阶段的显示名 → PHRASES 的 key（phase 是前端类型，不是后端的 RitualPhase） */
const PHASE_KEY: Record<string, string> = {
  contract: "contract",
  invocation: "invocation",
  card_selection: "card_selection",
  per_card: "per_card",
  interpretation: "per_card",
  synthesis: "synthesis",
  closing: "closing",
};

export default function ThinkingBubble({
  phase,
  /** 已经等了多久（秒） */
  elapsed,
  /** 轮次索引 —— 让短句在多轮之间轮换 */
  round,
}: {
  phase?: string | null;
  elapsed: number;
  round?: number;
}) {
  /**
   * ⚠️ 延迟出现（1.2s）
   *   理由：模型通常 1~3 秒就有第一个 token。
   *   如果一有请求就弹气泡，用户会看到"占卜师在想 → 立刻开始说话 → 气泡消失"
   *   的**闪烁**，比不显示更糟。
   *   1.2 秒是"确实卡住了"的感知阈值。
   *
   * ⚠️ 直接算而不用 useState + useEffect：
   *   `visible` 完全由 `elapsed` 推导，存进 state 反而多一次渲染
   *   （而且 React 19 的 set-state-in-effect 规则会拒绝这种写法）。
   */
  const visible = elapsed >= 1.2;

  const phrase = useMemo(() => {
    const key = (phase && PHASE_KEY[phase]) || "default";
    const pool = PHRASES[key] ?? PHRASES.default;
    // ⚠️ 索引同时用"轮次"和"时间" → 同一轮内短语稳定，跨轮会换
    return pool[(Math.floor(elapsed / 5) + (round ?? 0)) % pool.length];
  }, [phase, elapsed, round]);

  if (!visible) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.4 }}
      className="flex items-start gap-2.5"
      aria-live="polite"
    >
      {/* 头像：与占卜师气泡一致的小圆徽记 */}
      <div className="shrink-0 w-7 h-7 rounded-full border border-purple-400/30 bg-purple-900/40 flex items-center justify-center">
        <span className="text-sm text-purple-300/80 rune-breathe">✧</span>
      </div>

      <div className="flex-1 rounded-2xl border border-purple-500/20 bg-[#0d0819]/60 backdrop-blur-sm px-4 py-3">
        {/* 三点呼吸动画 —— "他还在" */}
        <div className="flex items-center gap-1.5 mb-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-purple-300/70"
              animate={{ opacity: [0.25, 1, 0.25], scale: [0.8, 1.15, 0.8] }}
              transition={{
                duration: 1.4,
                repeat: Infinity,
                delay: i * 0.22,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>

        {/* 占卜师口吻的短句 */}
        <p
          className="text-sm text-purple-100/80 leading-relaxed"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        >
          {phrase}
        </p>
      </div>
    </motion.div>
  );
}
