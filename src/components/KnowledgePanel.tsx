"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * RAG 知识面板 —— 展示 BM25 检索命中（牌名/字段/相关度分数/片段）
 * 面试官可视化看到"RAG 真的在检索"的关键组件
 *
 * v2：支持引文联动 —— 解读文本中的 [n] 点击后：
 *   1. 对应命中行滚动到可视区
 *   2. ring 高亮 2.5s
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
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  /* 监听 CitedReading 派发的引文高亮事件 */
  useEffect(() => {
    const onHighlight = (e: Event) => {
      const n = (e as CustomEvent<{ n: number }>).detail?.n;
      if (typeof n === "number" && n >= 1 && n <= hits.length) {
        setHighlightIdx(n - 1);
        const row = rowRefs.current[n - 1];
        row?.scrollIntoView({ behavior: "smooth", block: "center" });
        window.setTimeout(() => setHighlightIdx((h) => (h === n - 1 ? null : h)), 2500);
      }
    };
    window.addEventListener("tarot:highlight-cite", onHighlight);
    return () => window.removeEventListener("tarot:highlight-cite", onHighlight);
  }, [hits.length]);

  if (hits.length === 0) return null;

  return (
    <motion.div
      ref={panelRef}
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
        <span className="ml-auto text-[10px] text-sky-400/40">点击解读中的 [n] 可跳转至此</span>
      </div>
      <div className="p-3 grid gap-2 md:grid-cols-2">
        {hits.map((h, i) => (
          <motion.div
            key={h.chunkId}
            ref={(el) => { rowRefs.current[i] = el; }}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{
              opacity: 1,
              scale: 1,
              ...(highlightIdx === i
                ? {
                    boxShadow: "0 0 0 2px rgba(251,191,36,0.8), 0 0 24px rgba(251,191,36,0.35)",
                    backgroundColor: "rgba(120, 53, 15, 0.35)",
                  }
                : {}),
            }}
            className={`rounded-lg bg-sky-950/25 border px-3 py-2 transition-colors ${
              highlightIdx === i
                ? "border-amber-400/70"
                : "border-sky-500/15 hover:border-sky-400/35"
            }`}
          >
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="flex items-center gap-1.5 min-w-0">
                {/* 引文序号（与解读文本 [n] 对应） */}
                <span className="text-[10px] font-mono px-1 rounded bg-sky-500/15 border border-sky-400/30 text-sky-300/80 shrink-0">
                  [{i + 1}]
                </span>
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
