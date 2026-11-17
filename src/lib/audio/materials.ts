/**
 * 材质与风格定义 —— 整个应用的声音必须来自**同一种物理材料**
 *
 * ⚠️⚠️ 为什么"材质"是一等设计维度（而不是"风格"）：
 *   风格描述的是**听感**（空灵/深沉/流动），材质描述的是**物理来源**
 *   （玻璃/水/木/纸）。两者的区别在工程上很实在：
 *
 *   · 风格 → 影响**配乐的 prompt**（生成阶段）
 *   · 材质 → 影响**事件音效的合成方式**（运行时）
 *
 *   只统一风格而不统一材质，会出现一个典型问题：
 *   配乐是"玻璃风铃"，翻牌音效却是"合成的滤波正弦"
 *   → 两者频谱结构不同 → 叠在一起时翻牌音会"跳出来"
 *   → 用户感知到"这是两个东西"
 *
 *   → 统一材质后，翻牌 = 玻璃轻击、揭示 = 玻璃颂钵、阶段锣 = 低音玻璃锣
 *   → 全部落在同一族频谱上 → 听起来像**一件乐器的不同敲法**
 *
 * ⚠️ 为什么每种材质都要定一个"揭示音"的基频：
 *   牌面揭示是整个仪式**最重要的一下**（占卜师的第一句解读伴随它出现）
 *   → 它必须是全应用音色最亮、最有存在感的一个音
 *   → 所以基频由材质决定：A = C5（523Hz，明亮）/ B = G4（392Hz，温厚）
 */

import type { ScoreStyle } from "./phase";

/**
 * 事件音的语义
 *
 * ⚠️ 为什么把"音效种类"独立成枚举而不是散在调用点：
 *   事件音效是**协议的组成部分** —— 它标记仪式的节拍。
 *   命名统一后，调用点（page.tsx）读起来就像仪式脚本：
 *   「承约 → chime」「选牌 → select」「翻牌 → flip」
 */
export type SfxKind =
  | "flip"     // 翻牌（卡背翻到卡面）
  | "reveal"   // 牌面揭示（最重要的一下）
  | "select"   // 选中一张牌
  | "answer"   // 占卜师提问后，用户回答
  | "chime"    // 仪式开始 / 阶段开始的标记
  | "gong";    // 阶段转换（低沉的一记）

export interface Material {
  /** 风格的展示名 */
  label: string;
  /** 一句话说明这套装束的气质 */
  mood: string;

  /* ---- 事件音效的基频（Hz）---- */
  /** 牌面揭示的基频 —— 全应用最亮、最有存在感的音 */
  revealBase: number;
  /** 揭示音的泛音倍率（构成"颂钵"般的非谐波结构） */
  revealPartials: number[];
  /** 揭示音的衰减时长（秒）—— 太长会与下一段配乐叠成"嗡" */
  revealDecay: number;
  /** 阶段转换锣的基频 */
  gongBase: number;
  /** 阶段转换锣的衰减时长（秒） */
  gongDecay: number;
  /** 翻牌音效的噪声带通中心频率（Hz）—— 材质的"表面质感" */
  flipNoiseHz: number;
  /** 翻牌音效的低频叩击频率（Hz） */
  flipThumpHz: number;
  /**
   * 翻牌后的材质余韵（Hz）
   *
   * ⚠️ 为什么有材质要 0、有的不要：
   *   玻璃被敲会**余响**（余韵），水被拍**只有水声没有余响**。
   *   → 这一项就是"材质"最直观的听感差异
   */
  flipPingHz: number;

  /* ---- 空气层 ---- */
  /** 空气层的低通截止（Hz）—— 决定"房间"是明亮还是幽深 */
  airHz: number;

  /* ---- 配乐风格参数（生成阶段用）---- */
  /** 调性 */
  key: string;
  /** 速度（BPM） */
  bpm: number;
  /** 配器关键词 */
  instruments: string;
  /** 频率重心目标区间（Hz）—— 用于验收时的客观判据 */
  centroidRange: [number, number];
}

/**
 * ⚠️ 两套风格是**并存的**（用户可随时切换），所以它们必须：
 *   · 各自内部保持 7 段的一致性（同一调性/速度/材质）
 *   · 两套之间差异足够大（一亮一暗，一玻璃一水）
 *   → 切换风格时是"换了一套配乐"，而不是"参数微调"
 */
export const MATERIALS: Record<ScoreStyle, Material> = {
  A: {
    label: "星玻璃",
    mood: "空灵清冷 · 水晶与星光",
    revealBase: 523.25,          // C5 —— 明亮
    revealPartials: [1, 1.5, 2.0],
    revealDecay: 1.6,
    gongBase: 130.81,            // C3 —— 低音玻璃锣
    gongDecay: 2.4,
    flipNoiseHz: 3200,           // 玻璃的表面摩擦很"细"
    flipThumpHz: 220,
    flipPingHz: 1046,            // 玻璃的余响
    airHz: 2200,                 // 房间偏亮
    key: "A minor",
    bpm: 60,
    instruments: "glass bells, marimba, celesta, soft pizzicato strings, airy pad",
    centroidRange: [700, 1500],
  },
  B: {
    label: "深海低语",
    mood: "深沉包裹 · 深水与丝绒",
    revealBase: 392.0,           // G4 —— 温厚
    revealPartials: [1, 1.5, 2.0, 3.0],
    revealDecay: 2.2,
    gongBase: 65.41,             // C2 —— 深海钟
    gongDecay: 3.2,
    flipNoiseHz: 900,            // 水面的质感更"闷"
    flipThumpHz: 160,
    flipPingHz: 0,               // 水没有余响
    airHz: 800,                  // 房间幽深
    key: "D minor",
    bpm: 52,
    instruments: "cello, piano harmonics, sustained string pad, low bass clarinet",
    centroidRange: [300, 900],
  },
};

/** 全部风格的展示顺序（UI 用） */
export const STYLE_ORDER: ScoreStyle[] = ["A", "B"];
