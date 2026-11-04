"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Icon, { type IconName } from "@/components/icons";

/**
 * 子 Agent 流水线指示器 —— analyst → writer → reviewer 生命周期可视化
 * "多 Agent 协作"最直观的呈现
 */

export type SubAgentName = "analyst" | "writer" | "reviewer";

export interface SubAgentEvent {
  agent: SubAgentName | string;
  action: string;
  detail?: string;
}

/**
 * ⚠️ 2026-11-04：icon 从 emoji 换成 SVG 图标（用户诉求："想要更漂亮一点的图标"）
 */
const AGENT_META: Record<string, { icon: IconName; label: string; color: string }> = {
  analyst: { icon: "magnify", label: "牌意分析师", color: "text-sky-300 border-sky-400/40 bg-sky-500/10" },
  writer: { icon: "quill", label: "撰写者", color: "text-fuchsia-300 border-fuchsia-400/40 bg-fuchsia-500/10" },
  reviewer: { icon: "eye", label: "审校者", color: "text-emerald-300 border-emerald-400/40 bg-emerald-500/10" },
  supervisor: { icon: "masks", label: "占卜师", color: "text-purple-300 border-purple-400/40 bg-purple-500/10" },
};

export default function SubAgentPipeline({ events }: { events: SubAgentEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (events.length === 0) return null;

  return (
    <div className="w-full max-w-2xl mt-4 rounded-2xl border border-indigo-500/25 bg-[#0c0a1a]/80 backdrop-blur-md overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-2 border-b border-indigo-500/15">
        <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/15 border border-indigo-400/30 text-indigo-300 font-mono">
          MULTI-AGENT PIPELINE
        </span>
        <span className="text-indigo-200/60 text-xs flex items-center gap-1.5">
          <Icon name="magnify" size={12} />
          分析师
          <span className="text-indigo-300/40">→</span>
          <Icon name="quill" size={12} />
          撰写者
          <span className="text-indigo-300/40">→</span>
          <Icon name="eye" size={12} />
          审校者
        </span>
      </div>
      <div ref={ref} className="max-h-44 overflow-y-auto px-4 py-3 space-y-1.5">
        <AnimatePresence initial={false}>
          {events.map((e, i) => {
            const meta = AGENT_META[e.agent] ?? AGENT_META.supervisor;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
                className="flex items-center gap-2.5 text-xs"
              >
                <span className={`shrink-0 w-24 truncate px-1.5 py-0.5 rounded border flex items-center gap-1 ${meta.color}`}>
                  <Icon name={meta.icon} size={11} />
                  {meta.label}
                </span>
                <span className="text-zinc-300/85">{e.action}</span>
                {e.detail && <span className="text-zinc-500/70 text-[11px] truncate">{e.detail}</span>}
                {i === events.length - 1 && (
                  <span className="ml-auto shrink-0 text-indigo-400/60 animate-pulse">●</span>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
