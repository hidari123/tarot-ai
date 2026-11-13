"use client";

import { motion } from "framer-motion";

import Icon from "@/components/icons";
import PersonaOrb from "@/components/PersonaOrb";
import { MODE_PROFILES, type DivinationMode } from "@/lib/agent/divination-mode";

import type { PersonaView } from "../types";

/**
 * DivinationInput —— 输入阶段的三块 UI（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么合并成一个组件（而不是拆三个）：
 *   · 三块是**一个语义单元**：「选谁问 → 怎么问 → 问什么」
 *   · 它们共享外层的入场动画（delay 0.3 的 motion.div）
 *   · 拆三个 → 外层动画要么重复三遍、要么得再包一层 → 更复杂 ❌
 *   → 一个组件，内部三段 ✅
 *
 * ⚠️ 依赖全是 props → 组件**无状态**、可单独预览 ✅
 */

export interface DivinationInputProps {
  /** 可选的占卜师列表 */
  personas: PersonaView[];
  /** 当前选中的占卜师 */
  persona: PersonaView | null;
  /** 选择占卜师 */
  onSelectPersona: (p: PersonaView) => void;
  /** 当前占卜模式 */
  mode: DivinationMode;
  /** 切换占卜模式 */
  onChangeMode: (m: DivinationMode) => void;
  /** 问题输入框的内容 */
  question: string;
  /** 修改问题 */
  onChangeQuestion: (v: string) => void;
  /** 清空错误 */
  onClearError: () => void;
  /** 开始占卜 */
  onStart: () => void;
  /** 语音输入 */
  onVoice: () => void;
  /** 语音识别中 */
  listening: boolean;
}

export default function DivinationInput(props: DivinationInputProps) {
  const {
    personas,
    persona,
    onSelectPersona,
    mode,
    onChangeMode,
    question,
    onChangeQuestion,
    onClearError,
    onStart,
    onVoice,
    listening,
  } = props;

  return (
    <>
    <div className="mb-7">
      <p className="text-[11px] tracking-[0.28em] text-[rgba(212,175,55,0.72)] mb-4 text-center">
        选 择 你 的 占 卜 师
      </p>
      {/**
       * ⚠️ 2026-11-06：排列从 flex-wrap 改成 grid-cols-5。
       * ⚠️ 为什么：flex-wrap 下 5 个徽章是「4 + 1」——
       *   最后一个孤零零掉到第二行 → 视觉断裂（截图实测）。
       * → grid-cols-5 保证一行五个、间距均匀。
       *   移动端用 grid-cols-3（第二行两个居中）。
       */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-x-3 gap-y-5 justify-items-center max-w-[560px] mx-auto">
        {personas.map((p, pi) => (
          <PersonaOrb
            key={p.id}
            id={p.id}
            name={p.name}
            tagline={p.desc}
            selected={persona?.id === p.id}
            onClick={() => onSelectPersona(p)}
            index={pi}
          />
        ))}
      </div>
    </div>

    {/* ---------- 占卜模式切换（2026-11-04 双模式）----------
      ⚠️ 为什么放在输入框**上方**（而不是占卜开始后）：
        用户在**提问之前**就该知道这次会得到什么 ——
        "快速一问 vs 深度解读"是两种不同的**产品**，不是同一个东西的快慢版。
        放在后面就变成了"已经开始了才告诉我会等很久"（预期错配）。 */}
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      <span className="text-[11px] tracking-[0.2em] text-[rgba(212,175,55,0.62)]">占卜方式</span>
      {(Object.keys(MODE_PROFILES) as DivinationMode[]).map((m) => {
        const p = MODE_PROFILES[m];
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChangeMode(m)}
            aria-pressed={active}
            title={`${p.tagline} · 约 ${p.estSeconds[0]}~${p.estSeconds[1]} 秒`}
            className={`px-3 py-1.5 rounded-full text-xs tracking-[0.15em] border transition-all ${
              active
                ? "border-purple-400/60 bg-purple-500/20 text-purple-100 shadow-[0_0_16px_rgba(168,85,247,0.28)]"
                : "border-white/10 bg-white/[0.03] text-purple-300/50 hover:text-purple-200/80 hover:border-purple-400/30"
            }`}
          >
            {p.label}
            <span className="ml-1.5 text-[10px] opacity-55">
              {p.estSeconds[0]}~{p.estSeconds[1]}s
            </span>
          </button>
        );
      })}
      <span className="text-[10px] text-[rgba(196,181,253,0.55)] ml-1">
        {MODE_PROFILES[mode].tagline}
      </span>
    </div>

    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1">
        {/**
         * ⚠️ 2026-11-06 对比度修正：
         *   原来 `bg-purple-950/30` + `border-purple-500/30` 叠在紫背景上 → 输入框边界不清。
         * → 改为**深色实底 + 金色描边**，聚焦时金色发光（与魔法阵呼应）。
         */}
        <input
          className="w-full px-5 py-4 pr-12 text-lg rounded-2xl bg-[rgba(9,5,20,0.82)] backdrop-blur-md border border-[rgba(212,175,55,0.32)] text-[rgba(255,250,240,0.96)] placeholder-[rgba(190,178,235,0.42)] focus:outline-none focus:border-[rgba(240,217,138,0.75)] focus:shadow-[0_0_30px_rgba(212,175,55,0.30)] transition-all"
          style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          placeholder="在此写下你的困惑…"
          // ⚠️ P2-⑮：placeholder 不是可访问名称 —— 屏幕阅读器读不到。
          //   加 aria-label 让输入框有真正的名字。
          aria-label="写下你的问题"
          value={question}
          onChange={(e) => { onChangeQuestion(e.target.value); onClearError(); }}
          onKeyDown={(e) => e.key === "Enter" && onStart()}
          maxLength={100}
        />
        <button
          onClick={onVoice}
          title="语音输入"
          className={`absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
            listening ? "bg-rose-500/30 text-rose-300 animate-pulse" : "text-[rgba(203,190,255,0.75)] hover:text-amber-200"
          }`}
        >
          {listening ? (
            <span className="w-2.5 h-2.5 rounded-full bg-current animate-pulse" />
          ) : (
            <Icon name="thought" size={15} />
          )}
        </button>
      </div>
      {/**
       * ⚠️⚠️ 「开始占卜」按钮 —— 重新设计（2026-11-12）
       *
       * ⚠️ 用户要求：「开始占卜需要占满一行 可以重新设计按钮样式」
       *
       * ⚠️⚠️ 为什么丢掉旧的图片按钮（btn-start.png）：
       *   · 那是一张 640×360 的巴洛克金框（羊皮纸底 + 卷草边框）
       *   · 撑满一行（414px × 62px = 6.7:1）→ 框会被拉成一条线 ❌
       *   · 而且它和输入框视觉语言完全不同（深底金边 vs 羊皮纸卷草）
       *     → 并排放很别扭（这是用户最早提的问题）
       *
       * ⚠️ 新设计：深底 + 金色渐变描边（纯 CSS）
       *   · 与输入框同族：深底 + 金描边 + 圆角 → 统一 ✅
       *   · 纯 CSS → 任意宽度零变形 ✅
       *   · 移动端 w-full 占满一行，桌面端固定 142px
       */}
      <motion.button
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        onClick={onStart}
        className="group relative w-full sm:w-[142px] sm:shrink-0 h-[62px] rounded-2xl
          transition-all duration-300
          hover:shadow-[0_0_30px_rgba(212,175,55,0.35)]"
        style={{
          /**
           * ⚠️⚠️ 底色用变量切换（移动端金色底 / 桌面端深底）
           * ⚠️ 移动端要求「btn需要底色是金色的 内部文字是深色」
           *   → 金底深字（对比强、像实体按钮）
           * ⚠️ 桌面端保持深底金字（与输入框同族、统一）
           */
          background: "var(--btn-bg, rgba(9,5,20,0.82))",
          backdropFilter: "var(--btn-backdrop, blur(12px))",
          /**
           * ⚠️ 基础态描边：细金线（与输入框完全一致）
           * ⚠️ 渐变描边用**额外的 span + mask** 实现（见下）
           *   · border-image 会吃掉 border-width → 盒子尺寸会变 ❌
           *   → 双层法：外层画渐变框、mask 挖空中间 → 尺寸不变 ✅
           */
          border: "1px solid var(--btn-border, rgba(212,175,55,0.32))",
          boxShadow:
            "inset 0 0 22px rgba(212,175,55,0.10), 0 6px 20px rgba(0,0,0,0.45)",
        }}
      >
        {/**
         * ⚠️⚠️ 移动端：**金色底 + 深色字**（用户要求）
         * ⚠️ 桌面端保持深底 + 金字（与输入框同族）
         * → 用 CSS 变量控制，移动端在 globals.css 的媒体查询里切换
         */}
        <span
          className="pointer-events-none absolute inset-0 rounded-2xl
            opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{
            padding: "1px",
            background:
              "linear-gradient(135deg, #8a6a1e 0%, #e8c96a 38%, #f6e4a8 52%, #c9a24a 72%, #6d5216 100%)",
            WebkitMask:
              "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
            WebkitMaskComposite: "xor",
            maskComposite: "exclude",
          }}
        />
        {/* 内部柔光（hover 时亮起） */}
        <span
          className="pointer-events-none absolute inset-0 rounded-2xl opacity-0
            transition-opacity duration-300 group-hover:opacity-100"
          style={{
            background:
              "radial-gradient(ellipse 70% 120% at 50% 50%, rgba(240,205,120,0.16), transparent 72%)",
          }}
        />
        {/* 文字 */}
        <span
          className="relative flex h-full items-center justify-center
            text-lg font-semibold tracking-[0.14em]"
          style={{
            fontFamily: "'Ma Shan Zheng', serif",
            /**
             * ⚠️⚠️ 移动端：**深色字**（金色底上才看得清）
             * ⚠️ 桌面端：**金字**（深底上才看得清）
             * → 用变量切换（globals.css 的媒体查询）
             */
            color: "var(--btn-text, #f0d98c)",
            textShadow: "var(--btn-text-shadow, 0 0 12px rgba(212,175,55,0.45))",
          }}
        >
          开始占卜
        </span>
      </motion.button>
    </div>
    </>
  );
}
