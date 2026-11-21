"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import StardustCursor from "@/components/StardustCursor";
/**
 * ⚠️ 2026-11-05 视觉重设计：新的视觉基底
 *   · CelestialBackdrop —— 深空星云背景（含噪点/景深/暗角）
 *   · AstralCircle —— 真 SVG 星象魔法阵
 */
import CelestialBackdrop from "@/components/CelestialBackdrop";
import WitchOrb from "@/components/WitchOrb";
import AgentTrace from "@/components/AgentTrace";
import KnowledgePanel from "@/components/KnowledgePanel";
import CitedReading from "@/components/CitedReading";
import CardPreviewModal from "@/components/CardPreviewModal";
import DialogueFlow from "@/components/DialogueFlow";
import CardFan from "@/components/CardFan";
import ReviewCard from "@/components/ReviewCard";
import AmbienceToggle, { useAmbiencePhase } from "@/components/AmbienceToggle";
import LangToggle from "@/components/LangToggle";
import { useI18n } from "@/lib/i18n";
import TypeCards from "@/features/divination/components/TypeCards";
import OrbCategoryRing from "@/features/divination/components/OrbCategoryRing";
import { type DivinationType } from "@/features/divination/types/divination-types";
import MagicCircleLayer from "@/components/MagicCircleLayer";
import ClosingPanel from "@/components/ClosingPanel";
import Icon from "@/components/icons";

/* ------------------------------------------------------------------ */
/* 代码分割（P2-⑯）                                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ P2-⑯（第二轮优化分析 2026-11 ⑯）：这两个组件是**点开才用**的，
 *   但原来静态 import → 它们的代码进了**首屏 bundle**：
 *   · ShareCard —— Canvas 渲染逻辑 ~190 行（还带一套画布绘制工具函数）
 *   · SubAgentPipeline —— 流水线可视化
 *
 * ⚠️ 用 `next/dynamic` 拆出去 → 首屏 JS 变小，首屏渲染更快。
 * ⚠️ `ssr: false` 的原因：这两个组件都依赖浏览器 API
 *   （Canvas / document.fonts），服务端渲染没有意义。
 * ⚠️ 类型用 `import type` 单独引入 —— dynamic 拿不到类型。
 */


const ShareCardButton = dynamic(
  () => import("@/components/ShareCard").then((m) => m.default),
  { ssr: false, loading: () => null }
);
const SubAgentPipeline = dynamic(
  () => import("@/components/SubAgentPipeline").then((m) => m.default),
  { ssr: false, loading: () => null }
);
import { unlockAmbience, playSfx } from "@/lib/audio";
/* ---------------- 类型 ---------------- */

/**
 * ⚠️⚠️ 2026-11-12 拆分：类型与常量已移到 `src/features/divination/types.ts`
 * ⚠️ 为什么抽出去：
 *   · 这些类型被 UI 组件与 hooks 共同依赖 → 不能留在 page.tsx 里
 *   · 放在独立文件 → 依赖方向单向（components → hooks → types）→ 无循环依赖
 * ⚠️ 保留这些 import 是为了让下面的代码不用改（零行为变更）
 */
import { useDivinationState } from "@/features/divination/useDivinationState";
import { useFlowEntries } from "@/features/divination/useFlowEntries";
import { useDeltaBuffer } from "@/features/divination/useDeltaBuffer";
import { useStreamRunner } from "@/features/divination/useStreamRunner";
import { useCardActions } from "@/features/divination/useCardActions";
import { useFollowup } from "@/features/divination/useFollowup";
import HeroSection from "@/features/divination/components/HeroSection";
import DivinationInput from "@/features/divination/components/DivinationInput";
import StageProgress from "@/features/divination/components/StageProgress";
import {
  type FlowEntry,
} from "@/features/divination/types";


/* ---------------- 星空 & 魔法阵 ---------------- */


/**
 * 方向①：稳定用户标识（跨会话画像锚点）。
 * localStorage UUID：同一浏览器视为同一访客；隐私模式/无 localStorage 返回空（匿名）。
 */
function getUserKey(): string {
  try {
    let k = localStorage.getItem("tarot:userKey");
    if (!k) {
      k = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem("tarot:userKey", k);
    }
    return k;
  } catch {
    return "";
  }
}

/**
 * 提取分享卡摘要：优先取"收束段"（最后一段，通常是占卜师的综合结论，
 * 分享价值最高），没有明确分段时取末尾 240 字。
 * 段标【牌面·…】与【启示】保留（它们在卡面上有视觉意义），【追问】/【补充】段剔除。
 */
function extractShareSummary(reading: string): string {
  if (!reading) return "";
  const paragraphs = reading
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("【追问】") && !p.startsWith("【补充】"));
  if (paragraphs.length === 0) return "";
  // 收束段：最后一段（若太短 < 40 字，往前再合一段）
  let summary = paragraphs[paragraphs.length - 1];
  if (summary.length < 40 && paragraphs.length >= 2) {
    summary = `${paragraphs[paragraphs.length - 2]}\n${summary}`;
  }
  // 仍超长 → 截到 360 字（卡面 8 行 × ~28px 字号约能放下）
  if (summary.length > 360) summary = summary.slice(0, 360) + "…";
  return summary;
}


/* ---------------- 主页面 ---------------- */

/**
 * ⚠️ 哪些阶段要播"锣"（阶段转换音效，2026-11-04）
 * ⚠️ 为什么只挑这几个：
 *   阶段事件在一次占卜里会触发很多次（每次工具调用都有 phase），
 *   全播就成噪音了。
 *   只在**用户能感知到的仪式节点**播 —— 让"推进"被听见。
 *
 * ⚠️ 为什么用数组而不是 Set：
 *   项目有一条硬规则（verify-runtime-state.mjs 守卫）：
 *   **模块级可变容器必须收敛到 globalThis**（否则 HMR 重置状态）。
 *   `new Set(...)` 会被守卫判为"未收敛的模块级可变状态"。
 *   → 用普通数组（const 声明、内容不变，Set 的 has → includes）。
 *   4 个元素的数组，includes 的性能差异可以忽略。
 *
 * ⚠️ 2026-11-12 拆分：常量已移到 `@/features/divination/types`（见上方 import）
 */


import TarotApp from "@/features/divination/components/TarotApp";

/**
 * 首页（2026-11-19：逻辑抽到 TarotApp）
 * ⚠️ 首页和第二页（/reading）共用同一套占卜逻辑 → 避免漂移 ✅
 */
export default function Page() {
  return <TarotApp />;
}