"use client";

import { Fragment, useMemo, useState } from "react";
import { motion } from "framer-motion";

/**
 * 引文渲染器 —— 把解读文本中的 [n] 标记渲染为可点击引文角标
 *
 * 点击 [n]：
 *   1. 滚动 KnowledgePanel 中对应的命中行到可视区
 *   2. 该行高亮 2.5 秒（ring + 背景脉冲）
 *
 * 这是"RAG 可信度可视化"的最后一环：
 * 面试官可以逐条核对"解读里的每句话来自哪条典籍"。
 */

interface CitedReadingProps {
  text: string;
  /** 有效引文上限（命中条数） */
  maxCite: number;
  streaming?: boolean;
}

/** 把文本切成 { text } 与 { cite: n } 片段 */
function splitCitations(text: string): Array<{ text?: string; cite?: number }> {
  const parts: Array<{ text?: string; cite?: number }> = [];
  // 允许 [1] [2] [12] 形式；紧邻 "典籍有云" 后文也常见全角［１］，一并兼容
  const re = /[［[](\d{1,2})[］\]]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ cite: parseInt(m[1], 10) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export default function CitedReading({ text, maxCite, streaming }: CitedReadingProps) {
  const parts = useMemo(() => splitCitations(text), [text]);
  const [activeCite, setActiveCite] = useState<number | null>(null);

  /** 点击角标：广播高亮事件（page.tsx 监听并滚动 KnowledgePanel） */
  const handleCiteClick = (n: number) => {
    if (n < 1 || n > maxCite) return; // 越界引文（模型幻觉）不可点击
    setActiveCite(n);
    // 2.5s 后取消激活态
    window.setTimeout(() => setActiveCite((c) => (c === n ? null : c)), 2500);
    // 派发自定义事件，由外层路由到 KnowledgePanel
    window.dispatchEvent(new CustomEvent("tarot:highlight-cite", { detail: { n } }));
  };

  return (
    <pre
      className="whitespace-pre-wrap text-purple-50/90 text-base md:text-lg leading-loose tracking-wide"
      style={{ fontFamily: "'Ma Shan Zheng', serif" }}
    >
      {parts.map((p, i) =>
        p.cite !== undefined ? (
          <Fragment key={i}>
            <motion.button
              type="button"
              onClick={() => handleCiteClick(p.cite as number)}
              whileHover={p.cite <= maxCite ? { scale: 1.15 } : undefined}
              whileTap={p.cite <= maxCite ? { scale: 0.9 } : undefined}
              className={
                p.cite <= maxCite
                  ? `inline-block align-super cursor-pointer mx-0.5 px-1.5 py-0 rounded-md text-[10px] md:text-[11px] font-mono border transition-colors ${
                      activeCite === p.cite
                        ? "bg-amber-400/30 border-amber-300/70 text-amber-100 shadow-[0_0_14px_rgba(251,191,36,0.5)]"
                        : "bg-sky-500/10 border-sky-400/40 text-sky-300/90 hover:bg-sky-400/25 hover:border-sky-300/70"
                    }`
                  : "inline-block align-super mx-0.5 px-1 py-0 rounded-md text-[10px] md:text-[11px] font-mono border border-red-400/30 text-red-300/60 cursor-not-allowed"
              }
              title={
                p.cite <= maxCite
                  ? `查看典籍命中 ${p.cite} 的原文出处`
                  : `引文 ${p.cite} 超出命中范围（${maxCite} 条）——可能是模型幻觉`
              }
            >
              [{p.cite}]
            </motion.button>
          </Fragment>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
      {streaming && <span className="typing-cursor text-purple-300">▍</span>}
    </pre>
  );
}
