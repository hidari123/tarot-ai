"use client";

import { AnimatePresence, motion } from "framer-motion";

/**
 * RAG 知识面板 —— 展示 BM25 检索命中（牌名/字段/相关度分数/片段）
 * 面试官可视化看到"RAG 真的在检索"的关键组件
 */

export interface RagHitView {
  chunkId: string;
  cardNameZh: string;
  field: string;
  score: number;
  snippet: string;
  source: string;
}

const FIELD_LABEL: Record<string, string> = {
  description: "牌面叙事",
  upright: "正位牌意",
  reversed: "逆位牌意",
  keywords: "关键词",
};

export default function KnowledgePanel({ hits }: { hits: RagHitView[] }) {
  if (hits.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-2xl mt-4 rounded-2xl border border-sky-500/20 bg-[#0a0d1a]/80 backdrop-blur-md overflow-hidden"
    >
      <div className="px-4 py-2.5 flex items-center gap-2 text-sm border-b border-sky-500/15">
        <span className="text-xs px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-400/30 text-sky-300 font-mono">
          RAG
        </span>
        <span className="text-sky-200/80 text-xs tracking-wider">
          典籍检索命中 · BM25 Top-{hits.length}
        </span>
      </div>
      <div className="p-3 grid gap-2 md:grid-cols-2">
        {hits.map((h) => (
          <motion.div
            key={h.chunkId}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-lg bg-sky-950/25 border border-sky-500/15 px-3 py-2 hover:border-sky-400/35 transition-colors"
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-amber-200/90 text-xs font-medium truncate">{h.cardNameZh}</span>
                <span className="text-sky-400/60 text-[10px] shrink-0">{FIELD_LABEL[h.field] ?? h.field}</span>
              </div>
              {/* 相关度分数条 */}
              <div className="flex items-center gap-1.5 shrink-0">
                <div className="w-12 h-1 rounded-full bg-sky-950 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-sky-500 to-fuchsia-400"
                    style={{ width: `${Math.round(h.score * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] text-sky-300/70 font-mono">{h.score.toFixed(2)}</span>
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-sky-200/50 line-clamp-2">{h.snippet}</p>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
