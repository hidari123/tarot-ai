/**
 * 音频系统对外 API
 *
 * ⚠️ 为什么要有这一层（而不是让组件直接 import engine/score/sfx）：
 *   引擎、配乐、事件音、空气层是**四个协作的部件**：
 *   · 解锁音频 → 必须同时启动空气层和配乐层
 *   · 换风格   → 必须同时换曲子、换空气层材质
 *   · 关配乐   → 必须同时停总线和停 source
 *   如果让组件自己拼这些，组合逻辑会散落在各个调用点 → 迟早漏掉一半。
 *   → 这一层是**唯一的编排点**：组件只表达意图，这里决定怎么做。
 *
 * ⚠️ 层次结构：
 *   配乐层 Score（7 段 AI 曲子，主体）
 *   事件层 SFX （翻牌/揭示/锣，一次性标记仪式节拍）
 *   空气层 Air （-42dB 的房间底噪）
 *   → 三层共享同一个 master 音量与静音开关
 */

import { startAir, stopAir, updateAirMaterial } from "./air";
import {
  ensureEngine,
  getEngine,
  getMutedServerSnapshot,
  getMutedSnapshot,
  getScoreEnabledServerSnapshot,
  getScoreEnabledSnapshot,
  getStyleServerSnapshot,
  getStyleSnapshot,
  getVolumeServerSnapshot,
  getVolumeSnapshot,
  setEnginePhase,
  setMuted as engineSetMuted,
  setScoreEnabled as engineSetScoreEnabled,
  setStyle as engineSetStyle,
  setVolume as engineSetVolume,
  subscribeMuted,
  subscribeScoreEnabled,
  subscribeStyle,
  subscribeVolume,
  unlockAudio as engineUnlockAudio,
} from "./engine";
import { MATERIALS, STYLE_ORDER } from "./materials";
import { phaseForRitual, trackKey, type ScorePhase, type ScoreStyle } from "./phase";
import { applyScore, stopScore } from "./score";
import { playSfx } from "./sfx";

/* ══════════════════════════════════════════════════════════════
 * 生命周期
 * ══════════════════════════════════════════════════════════════ */

/**
 * 解锁音频（**必须在用户手势里调用**）
 *
 * ⚠️ 浏览器禁止无手势的自动播放 → AudioContext 创建出来也是 suspended。
 *   所以这一下必须发生在用户点击的同步上下文里（await 之前的部分）。
 */
export async function unlockAmbience(): Promise<void> {
  await engineUnlockAudio();
  startAir();
  await applyScore();
}

/** 停止一切声音（离开占卜页 / 卸载时） */
export function stopAmbience(): void {
  stopScore();
  stopAir();
}

/* ══════════════════════════════════════════════════════════════
 * 状态变更（编排点）
 * ══════════════════════════════════════════════════════════════ */

/**
 * 仪式阶段变化 → 切曲
 *
 * ⚠️ 这里做**语义映射**（ritual phase → score phase），不是直接一一对应：
 *   "card_selection" 与 "per_card" 都与"牌在动"有关，但必须是两首不同的曲子
 *   → 前者极稀疏（等你出手），后者才有旋律（牌在说话）
 */
export function setAmbienceLayer(phase: string | null | undefined): void {
  setEnginePhase(phaseForRitual(phase));
  void applyScore();
}

/** 直接设置配乐阶段（UI / 测试用） */
export function setScorePhase(phase: ScorePhase): void {
  setEnginePhase(phase);
  void applyScore();
}

/**
 * 切换风格
 *
 * ⚠️ 三件事要同时做：
 *   ① 记下新风格（引擎状态）
 *   ② 空气层换材质（"房间"的明暗）
 *   ③ 重新加载当前阶段的曲子（新的 style 对应另一套文件）
 */
export function setStyle(style: ScoreStyle): void {
  engineSetStyle(style);
  updateAirMaterial();
  void applyScore();
}

/**
 * 配乐层开关
 *
 * ⚠️ 关掉后只剩事件音效与空气层（用户可以只听翻牌声，不要背景乐）
 */
export function setScoreEnabled(enabled: boolean): void {
  engineSetScoreEnabled(enabled);
  void applyScore();
}

/** 静音 */
export function setMuted(muted: boolean): void {
  engineSetMuted(muted);
}

/** 音量（0~1） */
export function setVolume(volume: number): void {
  engineSetVolume(volume);
}

/* ══════════════════════════════════════════════════════════════
 * 重新导出
 * ══════════════════════════════════════════════════════════════ */

export { playSfx };
export { ensureEngine, getEngine };
export { MATERIALS, STYLE_ORDER };
export { phaseForRitual, trackKey };
export type { ScorePhase, ScoreStyle };
export type { SfxKind } from "./materials";

export {
  subscribeMuted,
  subscribeScoreEnabled,
  subscribeStyle,
  subscribeVolume,
  getMutedSnapshot,
  getMutedServerSnapshot,
  getVolumeSnapshot,
  getVolumeServerSnapshot,
  getScoreEnabledSnapshot,
  getScoreEnabledServerSnapshot,
  getStyleSnapshot,
  getStyleServerSnapshot,
};
