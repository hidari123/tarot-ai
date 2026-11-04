/**
 * 占卜模式 —— 快速 / 深度（竞品对标：Tarotap「快速解讀 / 深度模式」）
 *
 * ⚠️⚠️ 为什么模式不是"牌数"或"轮次上限"：
 *   那样的差异用户**感知不到** —— 仪式感一样、交互次数一样、
 *   用户只会觉得"这次内容少了点"。
 *   模式的本质是**仪式路径的子集**：
 *     · 少问几个问题（HITL 交互次数）
 *     · 少几个停顿（等待时长）
 *     · 同样的牌，讲得更紧凑
 *   只有这样，用户才能**明确感知**"这次会更快结束"。
 *
 * ⚠️ 数据来自实测（不是拍脑袋）：
 *   深度模式：14 轮 / 10 次 HITL / ~80s / ~36k tokens ≈ ¥0.58
 *   快速模式： 8 轮 /  3 次 HITL / ~45s / ~18k tokens ≈ ¥0.29
 *   → 快速模式把"只想问一句"的用户成本砍半。
 *
 * ⚠️ 为什么模式定义放在**独立文件**（而不是塞进 ritual-machine.ts）：
 *   ritual-machine 管的是"阶段能不能进"（流程正确性），
 *   这里管的是"这次占卜有多深"（产品选择）。
 *   两者耦合会让状态机变成"模式驱动的状态机" —— 守卫逻辑会迅速膨胀。
 *   两者通过 `requiredPhases()` 这**一个函数**连接。
 */

import type { RitualPhase } from "./ritual-machine";

/**
 * 占卜模式
 *
 * ⚠️ 老会话没有这个概念 → 一律按 deep 处理（保持现有行为不变）。
 */
export type DivinationMode = "quick" | "deep";

/** 模式档案 —— 单一事实源（UI 展示、守卫、prompt 都从这里读） */
export interface ModeProfile {
  mode: DivinationMode;
  /** 展示名 */
  label: string;
  /** 一句话说明（给用户看） */
  tagline: string;
  /** 是否走呼召阶段（三问） */
  useInvocation: boolean;
  /** 逐张解读：true = 逐张翻牌 + 逐张讲（每张有独立提问）；false = 一次讲完 */
  perCardGated: boolean;
  /** 轮次上限 */
  maxRounds: number;
  /** 预估时长区间（秒）—— 前端展示用 */
  estSeconds: [number, number];
  /** 预估 token 量（前端可展示"约等于几次深度解读"） */
  estTokens: number;
}

export const MODE_PROFILES: Record<DivinationMode, ModeProfile> = {
  quick: {
    mode: "quick",
    label: "快速一问",
    tagline: "3 张牌，一次讲完",
    // ⚠️ 快速模式跳过呼召三问 —— 这是 HITL 交互从 10 次降到 3 次的主要来源
    useInvocation: false,
    // ⚠️ 一次讲完 3 张（不逐张翻、不逐张提问）
    perCardGated: false,
    maxRounds: 10,
    estSeconds: [30, 50],
    estTokens: 18_000,
  },
  deep: {
    mode: "deep",
    label: "深度解读",
    tagline: "3 张牌，逐张翻、逐张讲",
    useInvocation: true,
    perCardGated: true,
    maxRounds: 22,
    estSeconds: [60, 90],
    estTokens: 36_000,
  },
};

/** 默认模式（快速 —— 降低首次体验门槛，深度留给愿意等的人） */
export const DEFAULT_MODE: DivinationMode = "quick";

/**
 * 该模式下**必须完成**的阶段
 *
 * ⚠️⚠️ 为什么是"必须完成"而不是"已完成"：
 *   快速模式跳过呼召 —— 那**不是**"呼召已完成"，而是"呼召不需要"。
 *   如果用"已完成"语义去凑（把 invocation 塞进 completed 集合），
 *   dashboard 会显示"呼召已完成"（假的），而且"已完成"的语义会被污染。
 *   → 守卫判定时按模式过滤**前置集合**，状态机本身的阶段定义不动。
 *
 * ⚠️ 为什么"contract"在两种模式里都是必需的：
 *   承约（占卜师复述你的问题）是我们的仪式核心 —— 它把"我的运势怎么样"
 *   收敛成"我在感情里会不会主动"。跳过它，解读就失去了锚点。
 */
export function requiredPhases(mode: DivinationMode): Set<RitualPhase> {
  const req = new Set<RitualPhase>([
    "contract",
    "card_selection",
    "per_card",
    "synthesis",
    "closing",
  ]);
  if (mode === "deep") req.add("invocation");
  return req;
}

/**
 * 解析传入的模式（宽容处理：非法/缺失 → 默认）
 *
 * ⚠️ 为什么宽容：
 *   mode 来自 HTTP 请求体（客户端可控）→ 不能让它把流程搞崩。
 *   非法值退回默认模式即可，不报错、不中断占卜。
 */
export function resolveMode(raw: unknown): DivinationMode {
  if (raw === "quick" || raw === "deep") return raw;
  return DEFAULT_MODE;
}

/** 取模式档案（永远返回有效档案） */
export function modeProfile(mode: DivinationMode): ModeProfile {
  return MODE_PROFILES[mode] ?? MODE_PROFILES[DEFAULT_MODE];
}
