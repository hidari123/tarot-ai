"use client";

import { useState } from "react";
import { motion } from "framer-motion";

/**
 * 收束追问面板（D）—— 解读结束后的回顾引导
 *
 * 真实塔罗师收尾时会问："哪一段最贴近你？"
 * 这一问把用户从"读完就走"拉回"继续深聊"，是追问环节的自然入口。
 */

export default function ClosingPanel({ question, options, onAnswer }: {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const opts = options && options.length > 0 ? options : ["过去那段", "现在那段", "未来那段"];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-xl mt-6 rounded-3xl border border-amber-400/25 bg-gradient-to-b from-amber-950/15 to-[#0b0514]/50 backdrop-blur-md p-6 text-center"
    >
      <span className="text-[10px] tracking-[0.3em] text-amber-300/60 block mb-3">收 束</span>
      <p
        className="text-lg md:text-xl text-purple-50/95 leading-relaxed mb-4"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        {question}
      </p>

      <div className="flex flex-col gap-2 mb-3">
        {opts.map((o) => (
          <motion.button
            key={o}
            whileHover={{ scale: 1.02, x: 3 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onAnswer(o)}
            className="text-left px-5 py-3 rounded-xl border border-amber-500/25 bg-amber-900/15 text-amber-100/90 hover:bg-amber-800/25 hover:border-amber-400/50 transition-all"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            {o}
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
          placeholder="或者，直接说说你想问的…"
          maxLength={120}
          className="flex-1 px-4 py-3 rounded-xl bg-purple-950/30 border border-purple-500/25 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-amber-400/50 transition-all"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
        />
        <button
          onClick={() => custom.trim() && onAnswer(custom.trim())}
          disabled={!custom.trim()}
          className="px-5 py-3 rounded-xl bg-gradient-to-r from-amber-700 to-orange-700 text-white font-medium disabled:opacity-40 transition-all"
        >
          说
        </button>
      </div>
      <p className="text-[10px] text-purple-400/35 mt-2">回答后可以继续追问，占卜师会接着你的话说</p>
    </motion.div>
  );
}
