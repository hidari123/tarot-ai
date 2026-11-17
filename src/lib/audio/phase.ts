/**
 * 阶段与风格的基础定义 —— 配乐层、事件层、UI 都以这里为准
 *
 * ⚠️ 为什么单独一个文件：
 *   `phase.ts` 是**纯数据 + 纯函数**，不含任何音频逻辑。
 *   好处是验证脚本（scripts/verify-ambience.mjs）可以直接 import 它
 *   来检查"7 个阶段 ↔ 7 首曲子"的映射完整性，不需要拉起浏览器。
 */

/** 配乐风格 ID */
export type ScoreStyle = "A" | "B";

/**
 * 仪式阶段 ↔ 配乐曲目
 *
 * ⚠️ 必须与仪式状态机的阶段**语义对齐**（不是名字对齐）：
 *   RitualPhase 里没有"idle"（待机），但配乐需要一个待机曲
 *   → 首页/等待输入时播 idle
 */
export type ScorePhase =
  | "idle"        // 待机 / 首页
  | "contract"    // 承约（用户刚问出问题）
  | "invocation"  // 呼召（占卜师提出三问）
  | "selection"   // 选牌（用户亲手挑牌）
  | "perCard"     // 逐张讲牌
  | "synthesis"   // 综合（多牌联读）
  | "closing";    // 收束

/** 全部阶段（顺序 = 仪式推进顺序） */
export const SCORE_PHASES: ScorePhase[] = [
  "idle",
  "contract",
  "invocation",
  "selection",
  "perCard",
  "synthesis",
  "closing",
];

/**
 * 仪式阶段 → 配乐阶段
 *
 * ⚠️ 仪式的 `RitualPhase` 与配乐阶段不是一一对应 —— 这里做**语义映射**：
 *   · card_selection 与 perCard 都表达"牌在动"，但前者是"等你出手"，后者是"牌在说话"
 *   · 两者必须是**不同的曲子**（前者极稀疏，后者才有旋律）
 */
export function phaseForRitual(phase: string | null | undefined): ScorePhase {
  switch (phase) {
    case "contract": return "contract";
    case "invocation": return "invocation";
    case "card_selection": return "selection";
    case "per_card": return "perCard";
    case "synthesis": return "synthesis";
    case "closing": return "closing";
    default: return "idle";
  }
}

/**
 * 曲目文件名（不含扩展名）
 *
 * ⚠️ 命名规则 `score-<风格>-<阶段>` 的原因：
 *   · 风格在前 → 同一风格的 7 首在目录里是连续的（人工试听时好找）
 *   · 阶段全小写（perCard → percard）→ 文件名全小写，跨平台安全
 *   · ⚠️ 这个 key 同时是 **manifest 里的索引名** → 改名要同步改 manifest
 */
export function trackKey(style: ScoreStyle, phase: ScorePhase): string {
  return `score-${style}-${phase.toLowerCase()}`;
}

/** 曲目的公开路径 */
export function trackUrl(style: ScoreStyle, phase: ScorePhase): string {
  return `/audio/${trackKey(style, phase)}.mp3`;
}
