"use client";

import { useState } from "react";
import { motion } from "framer-motion";

/**
 * 三问呼召面板（A3）—— 洗牌时占卜师在心里问的三件事
 *
 * 真实塔罗师洗牌时会默问：
 *   ① 我需要知道什么？ ② 我需要做什么？ ③ 我应当防范什么？
 * 这三个回答会直接成为解读的骨架——所以这里用**三个独立输入框**，
 * 而不是把三个问题塞进一个文本框。
 */

const PLACEHOLDERS = [
  "你心里最想听到的答案是什么？（例：大概什么时候能有消息）",
  "在这件事上，你打算怎么做？（例：继续投，但改投内推）",
  "你担心什么、还没真正面对？（例：怕又白投一场）",
];

export default function InvocationPanel({ questions, onAnswer }: {
  questions: string[];
  onAnswer: (answers: string[]) => void;
}) {
  const [vals, setVals] = useState<string[]>(questions.map(() => ""));

  const set = (i: number, v: string) => {
    setVals((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
  };

  const filled = vals.filter((v) => v.trim().length > 0).length;
  const canSubmit = filled > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="w-full max-w-xl mt-6 rounded-3xl border border-purple-500/30 bg-gradient-to-b from-purple-950/30 to-[#0b0514]/60 backdrop-blur-md p-6 md:p-7 shadow-[0_0_50px_rgba(139,92,246,0.14)]"
    >
      <div className="flex items-center justify-center gap-2 mb-2">
        <span className="text-xl">🔮</span>
        <span className="text-sm tracking-[0.25em] text-purple-200/85">呼 召</span>
        <span className="text-xl">🔮</span>
      </div>
      <p className="text-xs text-purple-300/50 mb-5 text-center tracking-wider">
        牌会回应你问出的问题——先问三件事
      </p>

      <div className="flex flex-col gap-4">
        {questions.map((q, i) => (
          <div key={i}>
            <div className="flex items-start gap-2 mb-1.5">
              <span className="text-[10px] mt-1.5 w-5 h-5 rounded-full border border-purple-400/40 text-purple-300/80 flex items-center justify-center shrink-0 font-mono">
                {i + 1}
              </span>
              <p
                className="text-sm md:text-base text-purple-100/90 leading-snug"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
              >
                {q}
              </p>
            </div>
            <input
              value={vals[i] ?? ""}
              onChange={(e) => set(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) onAnswer(vals.filter((v) => v.trim()));
              }}
              placeholder={PLACEHOLDERS[i] ?? "写下你的答案…"}
              maxLength={80}
              className="w-full ml-7 px-4 py-2.5 rounded-xl bg-purple-950/40 border border-purple-500/25 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-purple-400/60 transition-all text-sm"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button
          onClick={() => canSubmit && onAnswer(vals.filter((v) => v.trim()))}
          disabled={!canSubmit}
          className="flex-1 px-5 py-3 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white font-medium disabled:opacity-35 hover:shadow-[0_0_24px_rgba(139,92,246,0.4)] transition-all"
        >
          {filled === 0 ? "至少回答一个问题" : filled < 3 ? `回答 ${filled}/3 · 继续` : "以此呼召 · 开始洗牌"}
        </button>
      </div>
      <p className="text-[10px] text-purple-400/35 text-center mt-2">
        回答会直接决定这次解读讲什么——答得越具体，牌读得越准
      </p>
    </motion.div>
  );
}
