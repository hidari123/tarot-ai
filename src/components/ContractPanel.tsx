"use client";

import { useState } from "react";
import { motion } from "framer-motion";

/**
 * 承约面板（A1）—— 真实塔罗师碰牌前的第一步
 *
 * 形态：占卜师用"我听到的是…"复述收敛后的问题 + 牌阵范围声明，
 *      用户确认或修正。这是"问题定义"环节，视觉上要庄重、居中。
 */

export interface ContractView {
  question: string;
  scope?: string;
}

export default function ContractPanel({ contract, onAnswer }: {
  contract: ContractView;
  onAnswer: (answer: string) => void;
}) {
  const [custom, setCustom] = useState("");

  const presets = ["对，就是这个", "其实我想问点别的", "再具体一点"];

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="w-full max-w-xl mt-6 rounded-3xl border border-amber-500/30 bg-gradient-to-b from-amber-950/20 to-purple-950/25 backdrop-blur-md p-6 md:p-8 text-center shadow-[0_0_50px_rgba(245,158,11,0.12)]"
    >
      <div className="flex items-center justify-center gap-2 mb-4">
        <span className="text-xl">✦</span>
        <span className="text-sm tracking-[0.25em] text-amber-200/85">承 约</span>
        <span className="text-xl">✦</span>
      </div>

      <p className="text-xs text-purple-300/50 mb-3 tracking-wider">在碰牌之前，先把问题说定</p>

      <p
        className="text-lg md:text-xl text-purple-50/95 leading-relaxed mb-4"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        我听到的是——{contract.question}
      </p>

      {contract.scope && (
        <div className="mb-5 px-4 py-2.5 rounded-xl bg-purple-950/40 border border-purple-500/20">
          <p className="text-[11px] text-purple-300/50 mb-1 tracking-wider">本次牌阵</p>
          <p className="text-sm text-purple-200/80">{contract.scope}</p>
        </div>
      )}

      <div className="flex flex-col gap-2 mb-3">
        {presets.map((p) => (
          <motion.button
            key={p}
            whileHover={{ scale: 1.02, x: 3 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onAnswer(p)}
            className="text-left px-5 py-3 rounded-xl border border-amber-500/25 bg-amber-900/15 text-amber-100/90 hover:bg-amber-800/25 hover:border-amber-400/50 transition-all"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            {p}
          </motion.button>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) onAnswer(custom.trim());
          }}
          placeholder="或者，用你自己的话说清楚…"
          maxLength={120}
          className="flex-1 px-4 py-3 rounded-xl bg-purple-950/30 border border-purple-500/25 text-purple-50 placeholder-purple-300/35 focus:outline-none focus:border-amber-400/50 transition-all"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        />
        <button
          onClick={() => custom.trim() && onAnswer(custom.trim())}
          disabled={!custom.trim()}
          className="px-5 py-3 rounded-xl bg-gradient-to-r from-amber-700 to-orange-700 text-white font-medium disabled:opacity-40 transition-all"
        >
          确认
        </button>
      </div>
    </motion.div>
  );
}
