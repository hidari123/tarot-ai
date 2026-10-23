"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Agent Trace 面板 —— 展示 Agent 每一次工具调用（调用名/参数/结果/耗时）
 * + LLM 思考链（reasoning_content）折叠展示
 * 这是"面试官一眼看到 Agent 在跑"的核心可视化
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
}

const TOOL_META: Record<string, { icon: string; label: string; color: string }> = {
  rag_search: { icon: "📖", label: "典籍检索", color: "text-sky-300" },
  draw_cards: { icon: "🃏", label: "命运抽牌", color: "text-amber-300" },
  ask_user: { icon: "💭", label: "询问求卜者", color: "text-emerald-300" },
  write_reading: { icon: "✍️", label: "撰写命运之卷", color: "text-fuchsia-300" },
};

export default function AgentTrace({
  tools,
  reasoning,
  streaming,
}: {
  tools: ToolCall[];
  reasoning: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [showReasoning, setShowReasoning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [tools.length, open]);

  if (tools.length === 0 && !reasoning && !streaming) return null;

  return (
    <div className="w-full max-w-2xl mt-6 rounded-2xl border border-purple-500/25 bg-[#0d0716]/80 backdrop-blur-md overflow-hidden">
      {/* 头部 */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-purple-950/30 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-purple-200/90 tracking-wider">
          <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-400/30 text-purple-300 font-mono">
            AGENT TRACE
          </span>
          <span className="text-purple-300/60 text-xs">
            {tools.length > 0 && `${tools.length} 次工具调用`}
            {streaming && " · 运行中"}
          </span>
        </div>
        <span className={`text-purple-400/60 text-xs transition-transform ${open ? "rotate-180" : ""}`}>▼</span>
      </button>

      {/* 思考链折叠条 */}
      {reasoning && (
        <div className="px-4 pb-1">
          <button
            onClick={() => setShowReasoning((v) => !v)}
            className="text-xs text-indigo-300/70 hover:text-indigo-200 transition-colors"
          >
            {showReasoning ? "▾" : "▸"} 占卜师内心独白（LLM 思考链）
          </button>
          <AnimatePresence>
            {showReasoning && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <pre className="mt-1.5 mb-1 max-h-40 overflow-y-auto text-[11px] leading-relaxed text-indigo-200/50 whitespace-pre-wrap font-mono">
                  {reasoning}
                </pre>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* 工具调用时间线 */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div ref={listRef} className="max-h-56 overflow-y-auto px-4 pb-3 space-y-1.5">
              {tools.length === 0 && (
                <p className="text-xs text-purple-400/40 py-2 text-center">
                  {streaming ? "占卜师正在思考…" : "暂无工具调用"}
                </p>
              )}
              {tools.map((t, i) => {
                const meta = TOOL_META[t.name] ?? { icon: "🔧", label: t.name, color: "text-zinc-300" };
                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3 }}
                    className="flex items-start gap-2.5 text-xs font-mono"
                  >
                    <span className="text-purple-500/40 pt-0.5 shrink-0">{String(i + 1).padStart(2, "0")}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{meta.icon}</span>
                        <span className={`${meta.color} font-semibold`}>{meta.label}</span>
                        <span className="text-purple-400/30">·</span>
                        <span className="text-purple-300/50">{t.name}()</span>
                        <span className="text-purple-500/40 ml-auto shrink-0">{t.durationMs}ms</span>
                      </div>
                      <div className="text-purple-300/45 truncate" title={t.resultSummary}>
                        → {t.resultSummary}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
              {streaming && (
                <div className="flex items-center gap-2 text-xs text-purple-300/40 font-mono">
                  <span className="animate-pulse">◆</span> 等待下一步…
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
