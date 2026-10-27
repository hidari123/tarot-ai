"use client";

import { motion } from "framer-motion";

/**
 * 逐张解读的牌阵视图 —— 真实塔罗仪式的"牌阵"
 *
 * 状态机：
 *   待翻 ○  →  当前翻牌 ◉（放大 + 呼吸光晕）→  已解读 ✓（金色勾）
 *
 * 牌阵从左到右：过去 / 当下 / 未来（与解读顺序一致）
 */

export interface SpreadCard {
  index: number;
  id: string;
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
  /** 已完成解读 */
  done: boolean;
  /** 正在翻这张 */
  active: boolean;
}

export default function CardSpread({ cards, onFlip }: {
  cards: SpreadCard[];
  /** 点击已解读的牌可回看该段解读 */
  onFlip?: (index: number) => void;
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
                c.done ? "bg-amber-400/80" : c.active ? "bg-purple-400/70 animate-pulse" : "bg-purple-800/50"
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
                c.active
                  ? "border-purple-400/60 text-purple-200 bg-purple-900/40"
                  : c.done
                    ? "border-amber-400/40 text-amber-300/80 bg-amber-900/20"
                    : "border-purple-700/40 text-purple-400/50"
              }`}
            >
              {c.pos}
            </span>

            {/* 牌面：未揭示 = 纯牌背（剧透防护——选完牌不该一眼看到三张是什么）；
                active（正在翻）或 done（已解读）才显示牌面 */}
            <motion.button
              type="button"
              onClick={() => c.done && onFlip?.(c.index)}
              whileHover={c.done ? { scale: 1.05, y: -3 } : undefined}
              animate={
                c.active
                  ? { scale: [1, 1.04, 1], boxShadow: ["0 0 0px rgba(168,85,247,0)", "0 0 26px rgba(168,85,247,0.55)", "0 0 0px rgba(168,85,247,0)"] }
                  : { scale: 1 }
              }
              transition={c.active ? { duration: 2.2, repeat: Infinity } : { duration: 0.2 }}
              className={`relative w-full aspect-[2/3] rounded-xl overflow-hidden border transition-all ${
                c.active
                  ? "border-purple-400/70 shadow-[0_0_30px_rgba(168,85,247,0.35)]"
                  : c.done
                    ? "border-amber-400/45 cursor-pointer hover:border-amber-300/70"
                    : "border-purple-800/40"
              }`}
            >
              {c.active || c.done ? (
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
                </div>
              )}
              {c.done && (
                <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-amber-400/90 flex items-center justify-center z-10">
                  <span className="text-[10px] text-purple-950 font-bold">✓</span>
                </div>
              )}
            </motion.button>

            {/* 牌名：同样只在揭示后显示（未揭示显示 ?） */}
            <span
              className={`mt-2 text-xs md:text-sm text-center leading-tight ${
                c.done ? "text-amber-200/90" : c.active ? "text-purple-100/80" : "text-purple-400/35"
              }`}
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              {c.active || c.done ? (
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
