"use client";

import { motion } from "framer-motion";

/**
 * 审校报告卡片 —— 展示 reviewer 的三维度评分与结论
 * "AI 质检 AI" 的可视化，Reflexion 的直观呈现
 */

export interface ReviewData {
  pass: boolean;
  scores: { grounding: number; empathy: number; tone: number };
  comment: string;
  rewritten?: boolean;
}

const DIMS: { key: keyof ReviewData["scores"]; label: string; icon: string; color: string }[] = [
  { key: "grounding", label: "典籍忠实", icon: "📜", color: "from-sky-500 to-cyan-400" },
  { key: "empathy", label: "共情回应", icon: "💗", color: "from-rose-500 to-pink-400" },
  { key: "tone", label: "语气人格", icon: "🎭", color: "from-amber-500 to-yellow-400" },
];

export default function ReviewCard({ review }: { review: ReviewData }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="w-full max-w-2xl mt-4 rounded-2xl border border-emerald-500/25 bg-[#0a1410]/80 backdrop-blur-md p-5"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🧐</span>
          <span className="text-sm text-emerald-200/90 tracking-wider">审校者报告</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 font-mono">
            REVIEWER
          </span>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
            review.pass
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-400/40"
              : "bg-amber-500/20 text-amber-300 border border-amber-400/40"
          }`}
        >
          {review.pass ? "✓ 审校通过" : "↺ 已退回重写"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        {DIMS.map((d) => {
          const v = review.scores[d.key] ?? 0;
          return (
            <div key={d.key} className="rounded-xl bg-black/25 border border-white/5 px-3 py-2.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-sm">{d.icon}</span>
                <span className="text-xs text-zinc-300/80">{d.label}</span>
                <span className={`ml-auto text-sm font-bold ${v >= 7 ? "text-emerald-300" : v >= 5 ? "text-amber-300" : "text-rose-400"}`}>
                  {v}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${v * 10}%` }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                  className={`h-full rounded-full bg-gradient-to-r ${d.color}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-zinc-400/90 leading-relaxed">{review.comment}</p>
      {review.rewritten && (
        <p className="mt-2 text-[11px] text-amber-300/70">※ 初稿未达标准，撰写者已依据审校意见重写</p>
      )}
    </motion.div>
  );
}
