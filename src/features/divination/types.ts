/**
 * 占卜功能的共享类型与常量（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么这样组织（避免循环依赖 + 类型漂移）：
 *   · page.tsx 原本 2530 行 → 拆到 `src/features/divination/` 后各司其职
 *   · 本文件**从组件导入它们自带的类型**（FlowEntry/ToolCall/…）
 *     → 而不是复制一份
 *   ⚠️ 为什么不复制（我第一版犯的错）：
 *     · 我手写了一份 `FlowEntry` → 结构与 `DialogueFlow` 的**完全不同**
 *       （实际是 kind/ask/card/spread，我写成了 role/text/tools/…）
 *     → 复制类型必然漂移 → 迟早出类型错误
 *   → 正确做法：**单一来源** —— 类型住在它该在的地方，本文件只做转发 ✅
 *
 * ⚠️ 依赖方向（单向，无环）：
 *   components/*  →  （不依赖 features）
 *   features/divination/types.ts  →  components/*
   features/divination/hooks/*   →  features/divination/types.ts
 *   app/page.tsx  →  features/divination/*
 */

/* ---------------- 从组件转发类型（单一来源，不复制结构） ---------------- */

export type { ToolCall, RoundInfo } from "@/components/AgentTrace";
export type { RagHitView } from "@/components/KnowledgePanel";
export type { SpreadCard } from "@/components/CardSpread";
export type { PreviewCard } from "@/components/CardPreviewModal";
export type { FlowEntry } from "@/components/DialogueFlow";
export type { FanCard } from "@/components/CardFan";
export type { ReviewData } from "@/components/ReviewCard";
export type { SubAgentEvent } from "@/components/SubAgentPipeline";

/* ---------------- 本功能独有的类型 ---------------- */

export interface AgentCard {
  id: string;
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
}

export interface PersonaView {
  id: string;
  name: string;
  emoji: string;
  desc: string;
}

export type Phase =
  | "analyze"
  | "retrieve"
  | "draw"
  | "interpret"
  | "wait_user"
  | "review"
  | "done"
  | "error";

/**
 * ⚠️ 页面阶段（首页 / 洗牌翻牌 / 解读）
 * ⚠️ 拆出来是为了 UI 组件能按阶段判断渲染哪块
 */
export type Stage = "input" | "drawing" | "reading";

/* ---------------- 常量 ---------------- */

/**
 * ⚠️⚠️ 图标从 emoji 换成 **SVG 线条图标**（用户诉求："想要更漂亮一点的图标"）
 * ⚠️ 原因见 `src/components/icons.tsx` 的头注释：
 *   emoji 跨平台不一致（Windows/macOS/Android 三种长相）、
 *   Linux 上可能渲染成豆腐块、且与"暗紫金线"的古典调性不搭。
 *
 * ⚠️ 这里 import IconName：
 *   · `icons.tsx` 是**纯组件文件**，不依赖 features → 无循环依赖 ✅
 *   · 用 IconName（而不是 string）→ page.tsx 里的 `<Icon name={...}>` 能直接通过类型检查
 */
import type { IconName } from "@/components/icons";

export const PHASE_TEXT: Record<Phase, { title: string; icon: IconName }> = {
  analyze: { title: "凝听问题", icon: "crystal" },
  draw: { title: "命运之牌", icon: "cards" },
  retrieve: { title: "翻阅典籍", icon: "book" },
  interpret: { title: "撰写命运之卷", icon: "quill" },
  wait_user: { title: "等待你的回应", icon: "thought" },
  review: { title: "审校检视", icon: "eye" },
  done: { title: "解读完成", icon: "sparkle" },
  error: { title: "波动", icon: "orbit" },
};

export const PHASE_ORDER: Phase[] = [
  "analyze",
  "draw",
  "retrieve",
  "interpret",
  "review",
  "done",
];

/**
 * ⚠️ 召灵四阶段（用于进度指示）
 * ⚠️ 原为 page.tsx 里的局部常量 `STAGE_GONG_PHASES`
 */
export const STAGE_GONG_PHASES: string[] = [
  "invocation",
  "card_selection",
  "synthesis",
  "closing",
];
