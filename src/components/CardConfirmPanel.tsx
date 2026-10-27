"use client";

import { useState } from "react";
import { motion } from "framer-motion";

/**
 * 牌面确认面板（B）—— 翻牌后的确认问题
 *
 * 这是"像真实占卜师"的核心：占卜师念完牌，**停下来读用户**，
 * 问一个具体到能一眼作答的问题（"你是已经麻木了，还是其实不甘心？"）。
 *
 * 形态上与承约/呼召区分：贴着卡片出现的窄条，不像表单。
 */

export default function CardConfirmPanel({ question, options, cardLabel, onAnswer }: {
  question: string;
  options?: string[];
  cardLabel?: string;
  onAnswer: (answer: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const opts = options && options.length > 0 ? options : ["是这样", "其实不太像", "我说不上来"];

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-xl mt-4 rounded-2xl border border-purple-400/25 bg-[#0d0819]/80 backdrop-blur-md px-5 py-4"
    >
      {cardLabel && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-purple-400/35 text-purple-300/80">
            {cardLabel}
          </span>
          <span className="text-[10px] text-purple-400/40 tracking-wider">占卜师在读你</span>
        </div>
      )}

      <p
        className="text-base md:text-lg text-purple-50/95 leading-relaxed mb-3"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        {question}
      </p>

      <div className="flex flex-col gap-2">
        {opts.map((o) => (
          <motion.button
            key={o}
            whileHover={{ scale: 1.02, x: 3 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onAnswer(o)}
            className="text-left px-4 py-2.5 rounded-xl border border-purple-500/25 bg-purple-900/20 text-purple-100/90 hover:bg-purple-800/30 hover:border-purple-400/50 transition-all text-sm"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            {o}
          </motion.button>
        ))}
      </div>

      <div className="flex gap-2 mt-3">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) onAnswer(custom.trim());
          }}
          placeholder="或者，说点别的…"
          maxLength={100}
          className="flex-1 px-3.5 py-2.5 rounded-lg bg-purple-950/40 border border-purple-500/20 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-purple-400/50 transition-all text-sm"
        />
        <button
          onClick={() => custom.trim() && onAnswer(custom.trim())}
          disabled={!custom.trim()}
          className="px-4 py-2.5 rounded-lg bg-purple-700/70 text-white text-sm disabled:opacity-40 transition-all hover:bg-purple-600/70"
        >
          说
        </button>
      </div>
    </motion.div>
  );
}
