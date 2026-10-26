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
 *
 * v2：段落感知 —— 「【追问】xxx」行渲染为右对齐用户气泡，
 * 与占卜师回答在视觉上分离（多轮对话的信息架构）。
 */

interface CitedReadingProps {
  text: string;
  /** 有效引文上限（命中条数） */
  maxCite: number;
  streaming?: boolean;
}

/** 一个段落（追问气泡 / 牌面段标 / 正文段落） */
interface Paragraph {
  kind: "followup" | "cardHeader" | "body";
  /** 气泡里的问题文本（kind=followup 时） */
  question?: string;
  /** 牌面段标：位置 + 牌名（kind=cardHeader 时） */
  pos?: string;
  card?: string;
  /** 正文文本（kind=body 时） */
  text?: string;
}

/** 按空行拆段落；「【追问】」→ 用户气泡；「【牌面·位置·牌名】」→ 翻牌段标 */
function splitParagraphs(text: string): Paragraph[] {
  const paras: Paragraph[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t) continue;
    if (/^【追问】/.test(t)) {
      paras.push({ kind: "followup", question: t.replace(/^【追问】/, "").trim() });
      continue;
    }
    // 牌面段标：独立成行的「【牌面·过去·愚人】」或「【启示】」
    const cardM = t.match(/^【牌面·([^·】]+)·([^】]+)】$/);
    if (cardM) {
      paras.push({ kind: "cardHeader", pos: cardM[1].trim(), card: cardM[2].trim() });
      continue;
    }
    if (/^【启示】$/.test(t)) {
      paras.push({ kind: "cardHeader", pos: "启示", card: "" });
      continue;
    }
    paras.push({ kind: "body", text: t });
  }
  return paras;
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

/** 正文片段渲染（含可点击引文角标） */
function BodyText({ text, maxCite, activeCite, onCite }: {
  text: string;
  maxCite: number;
  activeCite: number | null;
  onCite: (n: number) => void;
}) {
  const parts = useMemo(() => splitCitations(text), [text]);
  return (
    <pre
      className="whitespace-pre-wrap text-purple-50/90 text-base md:text-lg leading-loose tracking-wide"
      style={{ fontFamily: "'Ma Shan Zheng', serif" }}
    >
      {parts.map((p, i) =>
        p.cite !== undefined ? (
          <motion.button
            key={i}
            type="button"
            onClick={() => onCite(p.cite as number)}
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
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </pre>
  );
}

export default function CitedReading({ text, maxCite, streaming }: CitedReadingProps) {
  const paragraphs = useMemo(() => splitParagraphs(text), [text]);
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
    <div className="flex flex-col gap-5">
      {paragraphs.map((p, i) =>
        p.kind === "followup" ? (
          /* 用户追问气泡：右对齐、靛蓝描边，与占卜师正文区分 */
          <div key={i} className="flex justify-end">
            <div
              className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-tr-sm bg-indigo-900/40 border border-indigo-400/30 text-indigo-100/90 text-sm md:text-base"
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              <span className="text-indigo-300/60 text-xs mr-1.5">追问</span>
              {p.question}
            </div>
          </div>
        ) : p.kind === "cardHeader" ? (
          /* 牌面段标：翻牌仪式感——金色牌名 + 位置徽章 */
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-3 mt-2"
          >
            <span className="text-lg md:text-xl text-amber-200/95" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
              {p.card ? p.card : ""}
            </span>
            {p.pos && (
              <span className="text-[10px] md:text-xs px-2 py-0.5 rounded-full border border-amber-400/40 text-amber-300/80 tracking-wider">
                {p.pos}
              </span>
            )}
            <span className="flex-1 h-px bg-gradient-to-r from-amber-400/30 to-transparent" />
          </motion.div>
        ) : (
          <BodyText
            key={i}
            text={p.text ?? ""}
            maxCite={maxCite}
            activeCite={activeCite}
            onCite={handleCiteClick}
          />
        )
      )}
      {streaming && (
        <span className="typing-cursor text-purple-300 self-start">▍</span>
      )}
    </div>
  );
}
