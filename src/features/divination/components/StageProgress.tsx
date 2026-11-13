"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

import CardSpread from "@/components/CardSpread";
import Icon from "@/components/icons";

import { PHASE_ORDER, PHASE_TEXT, type Phase, type SpreadCard } from "../types";

/**
 * StageProgress —— 占卜阶段的"进度可视化"三件套
 * （2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️ 三块：
 *   ① 牌阵横条（固定顶部，进度可见；与对话流牌阵同一份状态）
 *   ② Agent 状态条（符文路径 + 当前阶段）
 *   ③ 仪轨计划（Plan-Execute 模式可见）
 *
 * ⚠️ 为什么把 AgentStatusBar / WaitingHint 也搬进来：
 *   · 它们**只**被这三块用 → 天然内聚
 *   · 留在 page.tsx 会让那个文件继续背着不相关的 UI ✅
 */

export interface StageProgressProps {
  /** 牌阵（与对话流牌阵共用同一份状态） */
  spread: SpreadCard[];
  /** 翻牌 */
  onFlipCard: () => void;
  /** 打开牌面预览 */
  onPreview: (index: number) => void;
  /** 当前阶段 */
  phase: Phase | null;
  /** 当前阶段标签 */
  phaseLabel: string;
  /** 是否正在流式输出 */
  streaming: boolean;
  /** 是否有待回答的 HITL 问题 */
  hasAsk: boolean;
  /** 流开始时间（用于"已等待 N 秒"） */
  streamStart: number;
  /** 是否处于限速等待 */
  rateLimited: boolean;
  /** 仪轨计划步骤 */
  planSteps: string[];
}

/* ---------------- Agent 状态条 ---------------- */

function AgentStatusBar({ phase }: { phase: Phase | null }) {
const order = useMemo<Phase[]>(() => {
if (!phase) return PHASE_ORDER;
// wait_user / error 不在 PHASE_ORDER 里（是"横切状态"而非流程步骤）：
// 显示为在当前进度基础上叠加高亮，而不是把状态条塌缩成一项
const base = PHASE_ORDER.includes(phase as Phase) ? phase : null;
if (!base) {
// 横切状态：展示到 interpret 为止（等待/出错发生在解读流程中段）
return PHASE_ORDER.slice(0, 4);
}
const idx = PHASE_ORDER.indexOf(base);
return PHASE_ORDER.slice(0, Math.max(idx + 1, 1));
}, [phase]);
const curIdx = phase && PHASE_ORDER.includes(phase as Phase) ? PHASE_ORDER.indexOf(phase as Phase) : -1;

return (
/**
 * ⚠️ 2026-11-05 视觉重设计：从「药丸步骤条」改成「符文路径」。
 *
 * ⚠️ 为什么改：
 *   原来是一排圆角药丸 + "→" 箭头 —— 那是一个 **loading 步骤条**
 *   （像 CI 进度条），完全没有"仪轨"的感觉。
 *   → 改成：符文节点 + 发光连线（连续的光带 = 一条路）。
 *   节点是符文（每个阶段一个符号），当前节点有呼吸光。
 */
<div className="flex items-center gap-0 flex-wrap justify-center">
{order.map((p, i) => {
const active = i === curIdx;
const past = i < curIdx;
return (
<div key={p} className="flex items-center">
{i > 0 && (
/* 连线：已走过的是亮色光带，未走的是暗线 */
<span
className="w-5 sm:w-7 h-px mx-0.5 transition-colors duration-500"
style={{
background: past
? "linear-gradient(90deg, rgba(212,175,55,0.6), rgba(168,85,247,0.5))"
: "rgba(120,113,150,0.22)",
boxShadow: past ? "0 0 6px rgba(168,85,247,0.4)" : undefined,
}}
/>
)}
{/* 节点：符文 + 标题 */}
<div
className="flex items-center gap-1.5 px-1.5 transition-all duration-500"
style={{ opacity: active ? 1 : past ? 0.82 : 0.42 }}
>
<span
className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-500 ${
active ? "animate-pulse" : ""
}`}
style={{
border: `1px solid ${
active
? "rgba(212,175,55,0.75)"
: past
? "rgba(168,85,247,0.45)"
: "rgba(120,113,150,0.22)"
}`,
background: active
? "radial-gradient(circle at 34% 28%, rgba(120,72,190,0.85), rgba(20,10,42,0.9))"
: past
? "rgba(30,18,58,0.7)"
: "rgba(16,12,30,0.5)",
boxShadow: active
? "0 0 16px rgba(212,175,55,0.45)"
: past
? "0 0 8px rgba(139,92,246,0.2)"
: undefined,
}}
>
<Icon
name={PHASE_TEXT[p].icon}
size={12}
className={active ? "text-amber-100" : past ? "text-purple-200/80" : "text-purple-300/40"}
/>
</span>
<span
className={`text-[11px] md:text-xs tracking-[0.1em] whitespace-nowrap ${
active ? "text-amber-100" : past ? "text-purple-200/75" : "text-purple-300/40"
}`}
>
{PHASE_TEXT[p].title}
</span>
</div>
</div>
);
})}
{/* 横切状态徽章：wait_user / error 不属于流程步骤，单独追加显示 */}
{phase && !PHASE_ORDER.includes(phase as Phase) && phase !== null && PHASE_TEXT[phase] && (
<div className="flex items-center">
<span
className="w-5 sm:w-7 h-px mx-0.5"
style={{ background: "rgba(212,175,55,0.35)" }}
/>
<div
className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] md:text-xs animate-pulse ${
phase === "error"
? "bg-rose-900/40 border border-rose-400/50 text-rose-100"
: "bg-amber-900/40 border border-amber-400/50 text-amber-100"
}`}
>
<Icon name={PHASE_TEXT[phase].icon} size={13} />
<span>{PHASE_TEXT[phase].title}</span>
</div>
</div>
)}
</div>
);
}

/* ---------------- 等待提示 ---------------- */

function WaitingHint({ since, rateLimited }: { since: number; rateLimited?: boolean }) {
const [elapsed, setElapsed] = useState(0);

useEffect(() => {
if (!since) return;
const t = setInterval(() => setElapsed(Math.floor((Date.now() - since) / 1000)), 500);
return () => clearInterval(t);
}, [since]);

if (!since || elapsed < 3) return null;
const slow = elapsed >= 10;
/**
 * ⚠️ rateLimited 保留但**不用于文案**（2026-11-04）
 *   原因：用户诉求"别让用户感知到限流"——
 *   原文案直接写了"正在控制请求节奏以避免服务端限流"，
 *   用户看到"限流"两个字立刻不安（而且他什么都没做错）。
 *   → 两种等待（我们主动限速 / 模型真的慢）**对用户的感受是一样的**：
 *     都是"占卜师在想"。文案不该区分，也**不该暴露技术细节**。
 *   ⚠️ 参数保留是为了将来做**埋点**（想知道限流对等待时长的贡献有多大），
 *   而不是为了显示给用户。
 */
void rateLimited;

/**
 * ⚠️ 占卜师口吻的短句池
 *   · ⚠️ 刻意**不显示"限流"字样** —— 那是我们的内部实现细节
 *   · rateLimited 与否，用户看到的都是"占卜师在斟酌"（两种情况的**感受**相同）
 *   · 用轮换而不是固定文案：固定文案重复出现会显得很假
 */
const PHRASES = [
"占卜师在斟酌这句话背后的意思…",
"让我再对照一下典籍里的说法…",
"稍等，我在想这张牌该怎么落…",
"有几处细节想再确认一下…",
"正在把牌面的话连成一条线…",
];
// ⚠️ 用 elapsed 做索引 → 每隔几秒换一句（不随重渲染跳动）
const phrase = PHRASES[Math.floor(elapsed / 6) % PHRASES.length];

return (
<motion.p
initial={{ opacity: 0 }}
animate={{ opacity: 1 }}
className={`mt-1.5 text-center text-xs tracking-wide ${
slow ? "text-purple-300/70" : "text-purple-400/50"
}`}
>
{slow ? (
<>
{phrase}
<span className="text-purple-400/40"> · 已等待 {elapsed}s</span>
</>
) : (
<span className="text-purple-400/40">{elapsed}s</span>
)}
</motion.p>
);
}

/* ---------------- 主组件 ---------------- */

export default function StageProgress(props: StageProgressProps) {
  const {
    spread,
    onFlipCard,
    onPreview,
    phase,
    phaseLabel,
    streaming,
    hasAsk,
    streamStart,
    rateLimited,
    planSteps,
  } = props;

  return (
    <>
      {/* ---------- 牌阵横条（固定顶部，进度可见；与对话流牌阵同一份状态）---------- */}
      {spread.length > 0 && (
        <CardSpread cards={spread} onFlipCard={onFlipCard} onPreview={onPreview} />
      )}

      {/* ---------- Agent 状态条 ---------- */}
      {(phase || streaming) && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4">
      <AgentStatusBar phase={phase} />
      {phaseLabel && <p className="mt-2 text-center text-xs text-purple-400/60 tracking-wide">{phaseLabel}</p>}
      {streaming && !hasAsk && <WaitingHint since={streamStart} rateLimited={rateLimited} />}
        </motion.div>
      )}

      {/* ---------- 方向⑤：仪轨计划（Plan-Execute 模式可见）---------- */}
      {planSteps.length > 0 && (
        <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 w-full max-w-2xl rounded-2xl border border-indigo-500/25 bg-indigo-950/15 backdrop-blur-md px-5 py-3"
        >
      <p className="text-[11px] text-indigo-300/70 tracking-[0.25em] mb-1.5">PLAN · 仪轨路线图</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {planSteps.map((s, i) => (
      <span key={i} className="text-xs text-purple-200/75">
        <span className="text-indigo-400/80">{i + 1}.</span> {s.replace(/^[①②③④⑤⑥⑦⑧\d.、)\s]+/, "")}
      </span>
        ))}
      </div>
        </motion.div>
      )}

    </>
  );
}
