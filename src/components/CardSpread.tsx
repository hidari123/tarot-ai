"use client";

import { motion } from "framer-motion";

/**
 * 牌阵时间线（顶部固定条）—— 过去 / 当下 / 未来
 *
 * 状态机（逐张手动翻牌）：
 *   未翻开 ○  →  当前该翻 ◉（呼吸光 + 可点）→  已翻开 ●（牌面朝上）
 *                                                  →  已解读 ✓（金框 + 勾）
 *
 * ⚠️ 点击语义（**没有翻转功能**）：
 *   - 点"当前该翻的"牌 → 通知外层去翻牌（POST /api/answer）
 *   - 点"已翻开"的牌   → 打开放大预览（modal），只是看，不翻回去
 * 顶部与对话流里的牌阵共用同一份 state，翻一张两边同步。
 */

export interface SpreadCard {
  index: number;
  id: string;
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
  /** 已完成解读（解读结束后 → 金框 + ✓） */
  done: boolean;
  /** 正在翻这张（保留兼容，实际由 flipped 承担） */
  active: boolean;
  /** 用户已亲手翻开（→ 显示牌面；未翻开 = 牌背 + ？） */
  flipped: boolean;
  /** 是"当前该翻的"那张（→ 可点 + 呼吸光提示） */
  current: boolean;
}

export default function CardSpread({ cards, onFlipCard, onPreview }: {
  cards: SpreadCard[];
  /** 点击"当前该翻的"牌 → 触发翻牌 */
  onFlipCard?: (index: number) => void;
  /** 点击"已翻开"的牌 → 放大预览 */
  onPreview?: (index: number) => void;
}) {
  if (cards.length === 0) return null;
  const doneCount = cards.filter((c) => c.done).length;

  return (
    <div className="w-full max-w-2xl mt-6">
      {/* 进度条 */}
      <div className="flex items-center justify-center gap-2 mb-4">
        <span className="text-[11px] tracking-[0.2em] text-purple-300/50">解读进度</span>
        <div className="flex gap-1">
          {cards.map((c) => (
            <span
              key={c.id + c.index}
              className={`w-6 h-1 rounded-full transition-all ${
                c.done ? "bg-amber-400/80" : c.flipped ? "bg-purple-400/70" : "bg-purple-800/50"
              }`}
            />
          ))}
        </div>
        <span className="text-[11px] text-purple-300/40 font-mono">
          {doneCount}/{cards.length}
        </span>
      </div>

      {/* 牌阵 */}
      <div className="flex gap-4 md:gap-8 justify-center">
        {cards.map((c) => (
          <motion.div
            key={c.id + c.index}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: c.index * 0.08 }}
            className="flex flex-col items-center w-24 md:w-28"
          >
            {/* 位置徽章 */}
            <span
              className={`text-[10px] md:text-xs px-2 py-0.5 rounded-full border mb-2 tracking-wider ${
                c.current
                  ? "border-purple-400/60 text-purple-200 bg-purple-900/40"
                  : c.done
                    ? "border-amber-400/40 text-amber-300/80 bg-amber-900/20"
                    : "border-purple-700/40 text-purple-400/50"
              }`}
            >
              {c.pos}
            </span>

            {/* 牌面：未翻开 = 纯牌背（防剧透）；已翻开 = 牌面（永久朝上，不再翻回） */}
            <motion.button
              type="button"
              onClick={() => {
                if (c.flipped) onPreview?.(c.index);
                else if (c.current) onFlipCard?.(c.index);
              }}
              whileHover={c.flipped || c.current ? { scale: 1.05, y: -3 } : undefined}
              animate={
                c.current
                  ? { scale: [1, 1.04, 1], boxShadow: ["0 0 0px rgba(168,85,247,0)", "0 0 26px rgba(168,85,247,0.55)", "0 0 0px rgba(168,85,247,0)"] }
                  : { scale: 1 }
              }
              transition={c.current ? { duration: 2.2, repeat: Infinity } : { duration: 0.2 }}
              /* ⚠️ aspect-ratio 内联兜底（同 DialogueFlow：防 dev 增量缓存不生成
                 aspect-[2/3] 任意值类导致卡牌塌成横线） */
              style={{ aspectRatio: "2 / 3" }}
              className={`relative w-full rounded-xl overflow-hidden border transition-all ${
                c.current
                  ? "border-purple-400/70 shadow-[0_0_30px_rgba(168,85,247,0.35)] cursor-pointer"
                  : c.done
                    ? "border-amber-400/55 cursor-pointer hover:border-amber-300/80"
                    : c.flipped
                      ? "border-purple-500/40 cursor-zoom-in hover:border-purple-400/60"
                      : "border-purple-800/40"
              }`}
            >
              {c.flipped && c.image ? (
                <motion.div
                  initial={{ rotateY: 180, opacity: 0.6 }}
                  animate={{ rotateY: 0, opacity: 1 }}
                  transition={{ duration: 0.9, ease: [0.4, 0.1, 0.2, 1] }}
                  className="absolute inset-0 [perspective:600px]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.image}
                    alt={c.nameZh}
                    className={`w-full h-full object-cover ${c.reversed ? "rotate-180" : ""}`}
                  />
                </motion.div>
              ) : (
                /* 牌背：与旧版 TarotCardView 一致的星空牌背（看不到任何牌面信息） */
                <div className="absolute inset-0 bg-[#160b26] flex items-center justify-center">
                  <div className="w-10 h-10 rounded-full border-2 border-purple-400/50 flex items-center justify-center rune-breathe">
                    <span className="text-xl text-purple-300/70">✦</span>
                  </div>
                  <div className="absolute inset-1.5 rounded-lg border border-purple-500/25" />
                  {/* 当前该翻的牌：点我提示 */}
                  {c.current && (
                    <span className="absolute bottom-1.5 inset-x-0 text-center text-[10px] text-purple-200/80 tracking-wider">
                      点我翻开
                    </span>
                  )}
                </div>
              )}
              {c.done && (
                <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-amber-400/90 flex items-center justify-center z-10">
                  <span className="text-[10px] text-purple-950 font-bold">✓</span>
                </div>
              )}
            </motion.button>

            {/* 牌名：翻开才显示（未翻开显示 ?） */}
            <span
              className={`mt-2 text-xs md:text-sm text-center leading-tight ${
                c.done ? "text-amber-200/90" : c.flipped ? "text-purple-100/85" : "text-purple-400/35"
              }`}
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              {c.flipped ? (
                <>
                  {c.nameZh}
                  {c.reversed && <span className="text-[9px] block text-purple-300/50">逆位</span>}
                </>
              ) : (
                <span className="text-purple-400/30">？</span>
              )}
            </span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
