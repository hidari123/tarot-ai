/**
 * 音频引擎 —— AudioContext、三层总线、用户偏好
 *
 * ⚠️ 为什么拆成独立模块：
 *   配乐层（score）/ 事件层（sfx）/ 空气层（air）都需要**同一张音频图**：
 *   同一个 AudioContext、同一个 master 音量、同一个静音开关。
 *   如果各层自己建 AudioContext → 会出现多个上下文 → 音量控制失效、
 *   静音关不掉、CPU 翻倍。→ 引擎是唯一的图的拥有者，其他层只管往总线上挂。
 *
 * ⚠️ 为什么状态挂在 globalThis 上（不是 runtime.ts 的 runtimeState）：
 *   ① runtime.ts 是**服务端**状态容器（里面用了 process.pid）
 *      → 客户端音频模块 import 它会把服务端代码打进浏览器包
 *   ② 项目的硬规则是"模块级可变状态必须收敛到 globalThis"（CI 有静态扫描守卫）
 *      → 这里直接用 globalThis 的专用 key，满足规则且不引入跨端依赖
 *
 * ⚠️ 总线拓扑（每条线都有独立音量，便于分层调音）：
 *
 *      scoreBus ──┐
 *      sfxBus ────┼──→ master ──→ destination
 *      airBus ────┘        ↑
 *                          │
 *                    reverbWet ← convolver ←（sfxBus 的并行发送）
 *
 *   · scoreBus 直连 master —— AI 曲子里**已经烘焙了混响**
 *     再过一遍卷积会变浑浊，所以配乐不做湿声发送
 *   · sfxBus 额外并联一路进 convolver —— 合成音效没有空间感
 *     → 给它一点同空间的混响，才能和配乐"待在一起"
 *   · airBus 是一条极低电平的底噪 —— 填补乐句之间的死寂
 */

import { MATERIALS, type SfxKind } from "./materials";
import type { ScorePhase, ScoreStyle } from "./phase";

/* ══════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════ */

export interface AudioEngine {
  /** 音频上下文（首次用户手势时才创建） */
  ctx: AudioContext | null;
  /** 主输出总线 —— 用户音量在这里 */
  master: GainNode | null;
  /** 配乐总线 */
  scoreBus: GainNode | null;
  /** 事件音效总线 */
  sfxBus: GainNode | null;
  /** 空气层总线 */
  airBus: GainNode | null;
  /** 混响器（只给事件音效用） */
  convolver: ConvolverNode | null;
  /** 混响湿声增益 */
  reverbWet: GainNode | null;

  /* ---- 用户偏好 ---- */
  /** 主音量（0~1） */
  volume: number;
  /** 是否静音 */
  muted: boolean;
  /** 是否已解锁（用户手势已发生） */
  unlocked: boolean;
  /** 配乐层是否开启 */
  scoreEnabled: boolean;
  /** 当前风格 */
  style: ScoreStyle;
  /** 当前仪式阶段（配乐层据此切曲） */
  phase: ScorePhase;
}

/* ══════════════════════════════════════════════════════════════
 * 状态
 * ══════════════════════════════════════════════════════════════ */

const ENGINE_KEY = "__mysticTarotAudioEngine";

function getEngine(): AudioEngine {
  const g = globalThis as unknown as Record<string, AudioEngine | undefined>;
  if (!g[ENGINE_KEY]) {
    g[ENGINE_KEY] = {
      ctx: null,
      master: null,
      scoreBus: null,
      sfxBus: null,
      airBus: null,
      convolver: null,
      reverbWet: null,
      volume: 0.3,
      muted: true,
      unlocked: false,
      scoreEnabled: true,
      style: "A",
      phase: "idle",
    };
  }
  return g[ENGINE_KEY]!;
}

/* ══════════════════════════════════════════════════════════════
 * 订阅（给 useSyncExternalStore 用）
 * ══════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 为什么监听器集合也放 globalThis：
 *   Next.js 开发模式下模块会被反复重新求值（HMR），
 *   监听器集合若在模块作用域 → HMR 一次就被重置 → 已挂载组件订阅丢失
 *   → UI 状态与实际音频状态不同步。
 */
const LISTENERS_KEY = "__mysticTarotAudioListeners";

type ListenerKey = "volume" | "muted" | "scoreEnabled" | "style";

function getListeners(): Record<ListenerKey, Set<() => void>> {
  const g = globalThis as unknown as Record<string, Record<ListenerKey, Set<() => void>> | undefined>;
  if (!g[LISTENERS_KEY]) {
    g[LISTENERS_KEY] = {
      volume: new Set(),
      muted: new Set(),
      scoreEnabled: new Set(),
      style: new Set(),
    };
  }
  return g[LISTENERS_KEY]!;
}

function notify(key: ListenerKey): void {
  for (const fn of getListeners()[key]) fn();
}

export function subscribeVolume(fn: () => void): () => void {
  const set = getListeners().volume;
  set.add(fn);
  return () => { set.delete(fn); };
}

export function subscribeMuted(fn: () => void): () => void {
  const set = getListeners().muted;
  set.add(fn);
  return () => { set.delete(fn); };
}

export function subscribeScoreEnabled(fn: () => void): () => void {
  const set = getListeners().scoreEnabled;
  set.add(fn);
  return () => { set.delete(fn); };
}

export function subscribeStyle(fn: () => void): () => void {
  const set = getListeners().style;
  set.add(fn);
  return () => { set.delete(fn); };
}

/* ══════════════════════════════════════════════════════════════
 * 音频图
 * ══════════════════════════════════════════════════════════════ */

/**
 * 生成混响的脉冲响应（IR）
 *
 * ⚠️ 为什么要**程序化生成**而不是用 IR 音频文件：
 *   IR 是一段"声音在房间里反弹"的录音。
 *   程序化合成 = 零字节体积 + 零版权风险 + 可按材质调参。
 *
 * ⚠️ 为什么必须包含**早期反射**（0~80ms）：
 *   纯指数衰减噪声听起来是"糊的雾"，人脑判断不出房间大小。
 *   真实房间的混响分两段：
 *     ① 早期反射（几声稀疏脉冲）→ 告诉耳朵"墙有多远、房间多大"
 *     ② 扩散尾（密集衰减噪声）→ 空间的体积感
 *   → 只有 ② = 假的空间感
 */
function makeImpulseResponse(ctx: AudioContext, seconds = 1.8, decay = 2.4): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);

  /** 早期反射的（相对时间秒, 增益）—— 一个中等石室的手调值 */
  const EARLY: Array<[number, number]> = [
    [0.009, 0.58], [0.014, 0.44], [0.021, 0.51],
    [0.028, 0.34], [0.037, 0.41], [0.048, 0.27],
    [0.062, 0.31], [0.079, 0.19],
  ];

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    // ① 扩散尾
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    // ② 早期反射（左右声道错开 → 声场展开而不是贴在正前方）
    const jitter = ch === 0 ? 1 : 1.16;
    for (const [t, g] of EARLY) {
      const idx = Math.floor(t * jitter * rate);
      if (idx < len) {
        data[idx] += g * (Math.random() > 0.5 ? 1 : -1);
        if (idx + 1 < len) data[idx + 1] += g * 0.5;
      }
    }
  }
  return ir;
}

/**
 * 创建/恢复音频图
 *
 * ⚠️ **必须由用户手势触发** —— Chrome/Safari 禁止无手势的自动播放，
 *   AudioContext 创建出来也是 suspended 状态。
 */
export function ensureEngine(): AudioEngine | null {
  const st = getEngine();
  if (st.ctx) {
    if (st.ctx.state === "suspended") void st.ctx.resume();
    return st;
  }
  if (typeof window === "undefined") return null;

  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;

  try {
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0; // 从 0 淡入，避免"啪"的一声
    master.connect(ctx.destination);

    const scoreBus = ctx.createGain();
    scoreBus.gain.value = 1;
    scoreBus.connect(master);

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = 1;
    sfxBus.connect(master);

    const airBus = ctx.createGain();
    airBus.gain.value = 1;
    airBus.connect(master);

    // 事件音效的空间感（并行湿声发送）
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulseResponse(ctx);
    const reverbWet = ctx.createGain();
    reverbWet.gain.value = 0.32;
    const send = ctx.createGain();
    send.gain.value = 0.5;
    sfxBus.connect(send);
    send.connect(convolver);
    convolver.connect(reverbWet);
    reverbWet.connect(master);

    st.ctx = ctx;
    st.master = master;
    st.scoreBus = scoreBus;
    st.sfxBus = sfxBus;
    st.airBus = airBus;
    st.convolver = convolver;
    st.reverbWet = reverbWet;
    st.unlocked = true;
    return st;
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
 * 用户偏好
 * ══════════════════════════════════════════════════════════════ */

/**
 * 解锁音频（**必须在用户手势里调用**）
 *
 * 用法：占卜"开始"按钮的 onClick 里 `await unlockAudio()`。
 */
export async function unlockAudio(): Promise<void> {
  const st = ensureEngine();
  if (!st?.ctx || !st.master) return;
  if (st.ctx.state === "suspended") {
    try {
      await st.ctx.resume();
    } catch {
      /* 用户可能拒绝了自动播放 */
    }
  }
  st.unlocked = true;
  const now = st.ctx.currentTime;
  const target = st.muted ? 0 : st.volume;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(target, now + 1.2);
}

/** 静音 / 取消静音 */
export function setMuted(muted: boolean): void {
  const st = getEngine();
  st.muted = muted;
  notify("muted");
  if (!st.ctx || !st.master) return;
  const now = st.ctx.currentTime;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(muted ? 0 : st.volume, now + 0.6);
}

/** 设置主音量（0~1） */
export function setVolume(volume: number): void {
  const st = getEngine();
  const v = Math.max(0, Math.min(1, volume));
  st.volume = v;
  notify("volume");
  if (!st.ctx || !st.master || st.muted) return;
  const now = st.ctx.currentTime;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(v, now + 0.25);
}

/** 配乐层开关（关掉后只留事件音效与空气层） */
export function setScoreEnabled(enabled: boolean): void {
  const st = getEngine();
  st.scoreEnabled = enabled;
  notify("scoreEnabled");
  if (!st.ctx || !st.scoreBus) return;
  const now = st.ctx.currentTime;
  st.scoreBus.gain.cancelScheduledValues(now);
  st.scoreBus.gain.setValueAtTime(st.scoreBus.gain.value, now);
  st.scoreBus.gain.linearRampToValueAtTime(enabled ? 1 : 0, now + 0.8);
}

/**
 * 切换风格
 *
 * ⚠️ 这里只改状态，**不负责换曲** —— 换曲由 score 层根据 style 重新加载。
 */
export function setStyle(style: ScoreStyle): void {
  const st = getEngine();
  if (st.style === style) return;
  st.style = style;
  notify("style");
}

/** 记录当前仪式阶段（配乐层据此切曲） */
export function setEnginePhase(phase: ScorePhase): void {
  getEngine().phase = phase;
}

/* ══════════════════════════════════════════════════════════════
 * 快照（useSyncExternalStore 用）
 * ══════════════════════════════════════════════════════════════ */

export function getVolumeSnapshot(): number {
  return getEngine().volume;
}

export function getMutedSnapshot(): boolean {
  return getEngine().muted;
}

export function getScoreEnabledSnapshot(): boolean {
  return getEngine().scoreEnabled;
}

export function getStyleSnapshot(): ScoreStyle {
  return getEngine().style;
}

/**
 * ⚠️ 服务端快照必须与客户端初值一致，否则 hydration 不匹配。
 *   服务端没有音频状态 → 一律报"静音"（默认不出声）。
 */
export function getMutedServerSnapshot(): boolean {
  return true;
}

export function getVolumeServerSnapshot(): number {
  return 0.3;
}

export function getScoreEnabledServerSnapshot(): boolean {
  return true;
}

export function getStyleServerSnapshot(): ScoreStyle {
  return "A";
}

/* ══════════════════════════════════════════════════════════════
 * 便捷读取
 * ══════════════════════════════════════════════════════════════ */

export function getCurrentStyle(): ScoreStyle {
  return getEngine().style;
}

export function getCurrentMaterial() {
  return MATERIALS[getEngine().style];
}

export function getCurrentPhase(): ScorePhase {
  return getEngine().phase;
}

export { getEngine };
export type { SfxKind };
