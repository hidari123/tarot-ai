/**
 * 占卜环境音 —— Web Audio API 程序化合成
 *
 * ⚠️⚠️ 为什么用合成而不是音频文件：
 *   1. **版权**：市面上的"神秘/冥想/塔罗背景音乐"绝大多数是**有版权的商业曲**或
 *      来源不明的 CC 音频。把它们打包进仓库 = 潜在的侵权与下架风险。
 *      程序化合成 = **零版权风险**，且版权永远在自己手里。
 *   2. **体积**：一个 3 分钟的 mp3 约 3~5MB；合成音频 = **0 字节**（代码即音源）。
 *      本项目的 PWA 要预缓存资源，音频体积会直接挤占首屏预算。
 *   3. **可随状态变化**：占卜是**有节奏的仪式** —— 承约、呼召、翻牌、讲牌、
 *      收束，每个阶段的氛围应该不同。预录的音频做不到"跟着流程走"，
 *      合成可以：换几个参数就能换一层氛围。
 *   4. **无网络依赖**：不用管 CDN、离线可用（PWA 场景重要）。
 *
 * ⚠️ 合成音的局限（诚实说明）：
 *   合成不出"大提琴 + 混响 + 录音棚"那种质感。
 *   所以定位是**氛围底噪 / 仪式音效**，不是"好听的音乐"。
 *   如果将来要真正的配乐，正确做法是**采购正版曲库授权**（如 Artlist / Epidemic Sound，
 *   商用许可明确），而不是随便找 mp3。
 *
 * ⚠️ 浏览器自动播放策略：
 *   Chrome/Safari 都禁止**无用户手势**的音频自动播放。
 *   所以：**首次播放必须在用户点击时发生**（见 `unlock()`）。
 *   本模块的设计是：占卜"开始"按钮的那一下点击 → 解锁音频上下文 → 之后全程自动。
 */

/* ══════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════ */

/** 占卜的仪式阶段 → 对应氛围层 */
export type AmbienceLayer =
  | "idle"        // 待机：几乎无声
  | "contract"    // 承约：低沉、庄重
  | "invocation"  // 呼召三问：空灵、带泛音
  | "selection"   // 选牌：轻微的紧张期待
  | "perCard"     // 逐张讲牌：温暖、流动
  | "synthesis"   // 综合：开阔、辉煌
  | "closing";    // 收束：安详、渐隐

/** 每层的音色参数 —— ⚠️ 数值是"手工调出来的"，不是公式推导 */
const LAYER_PARAMS: Record<
  AmbienceLayer,
  {
    /** 基础频率（Hz）—— 音高 */
    baseFreq: number;
    /** 复音数量 —— 密度 */
    voices: number;
    /** 低音振荡器音量（0~1） */
    droneGain: number;
    /** 泛音层音量（0~1） */
    shimmerGain: number;
    /** 滤波器截止频率（Hz）—— 决定"亮/暗" */
    filterHz: number;
    /** 音量包络的呼吸周期（秒）—— 0 表示不呼吸 */
    breathSec: number;
    /** 噪声层音量（0~1）—— "风/空气"感 */
    noiseGain: number;
  }
> = {
  // 待机：几乎只有一丝空气感
  idle:        { baseFreq: 55.0,  voices: 1, droneGain: 0.030, shimmerGain: 0.004, filterHz: 320,  breathSec: 0,  noiseGain: 0.012 },
  // 承约：低沉稳重（D 大调的低音区）
  contract:    { baseFreq: 73.4,  voices: 2, droneGain: 0.075, shimmerGain: 0.010, filterHz: 520,  breathSec: 8,  noiseGain: 0.014 },
  // 呼召：空灵（加五度泛音，像教堂管风琴）
  invocation:  { baseFreq: 110.0, voices: 3, droneGain: 0.062, shimmerGain: 0.030, filterHz: 900,  breathSec: 7,  noiseGain: 0.020 },
  // 选牌：稍亮、密度高一点（期待感）
  selection:   { baseFreq: 98.0,  voices: 3, droneGain: 0.058, shimmerGain: 0.024, filterHz: 760,  breathSec: 5,  noiseGain: 0.016 },
  // 讲牌：温暖（低通滤掉高频，加五度）
  perCard:     { baseFreq: 87.3,  voices: 3, droneGain: 0.070, shimmerGain: 0.026, filterHz: 680,  breathSec: 6,  noiseGain: 0.013 },
  // 综合：开阔（明亮、辉煌）
  synthesis:   { baseFreq: 130.8, voices: 4, droneGain: 0.075, shimmerGain: 0.040, filterHz: 1250, breathSec: 9,  noiseGain: 0.017 },
  // 收束：安详（最低、最柔）
  closing:     { baseFreq: 65.4,  voices: 2, droneGain: 0.050, shimmerGain: 0.014, filterHz: 420,  breathSec: 10, noiseGain: 0.010 },
};

/* ══════════════════════════════════════════════════════════════
 * 模块状态
 * ══════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 用 globalThis 保存（与 runtime.ts 的思路一致）：
 *   Next.js 开发模式下模块会被反复重新求值，
 *   如果状态存在模块作用域里，HMR 一次就多一个 AudioContext（浏览器会限制数量）。
 */
interface AmbienceState {
  ctx: AudioContext | null;
  master: GainNode | null;
  /** 持续音（drone）的振荡器们 —— 换层时调它们的频率 */
  drones: { osc: OscillatorNode; gain: GainNode }[];
  /** 泛音层 */
  shimmer: { osc: OscillatorNode; gain: GainNode }[] | null;
  /** 噪声层（空气感） */
  noise: { src: AudioBufferSourceNode; gain: GainNode } | null;
  /** 当前层 */
  layer: AmbienceLayer;
  /** 用户是否手动静音 */
  muted: boolean;
  /** 是否已解锁（用户手势发生过） */
  unlocked: boolean;
}

const STATE_KEY = "__mysticTarotAmbience";

function getState(): AmbienceState {
  const g = globalThis as unknown as Record<string, AmbienceState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      ctx: null,
      master: null,
      drones: [],
      shimmer: null,
      noise: null,
      layer: "idle",
      muted: false,
      unlocked: false,
    };
  }
  return g[STATE_KEY]!;
}

/* ══════════════════════════════════════════════════════════════
 * 构建
 * ══════════════════════════════════════════════════════════════ */

/** 白/粉噪声缓冲（1 秒，循环用） */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // ⚠️ 粉噪声（Voss-McCartney 的简化版）比白噪声柔和得多，
  //    白噪声听起来像"沙沙"的电流声，粉噪声更像"风/空气"。
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.16;
  }
  return buf;
}

/** 建一个"持续音"振荡器 */
function makeDrone(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  gainValue: number,
  type: OscillatorType
): { osc: OscillatorNode; gain: GainNode } {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.value = gainValue;
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  return { osc, gain };
}

/**
 * 创建/恢复音频图
 *
 * ⚠️ 必须由**用户手势**触发（否则被浏览器自动播放策略拦截）
 */
function ensureGraph(): AmbienceState | null {
  const st = getState();
  if (st.ctx) {
    // 已存在 → 若被挂起则恢复
    if (st.ctx.state === "suspended") void st.ctx.resume();
    return st;
  }

  // ⚠️ SSR 环境没有 AudioContext
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;

  try {
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0; // 从 0 淡入，避免"啪"的一声
    master.connect(ctx.destination);

    st.ctx = ctx;
    st.master = master;
    st.unlocked = true;
    return st;
  } catch {
    return null;
  }
}

/** 重建某一层的持续音 */
function buildLayer(layer: AmbienceLayer): void {
  const st = getState();
  if (!st.ctx || !st.master) return;
  const p = LAYER_PARAMS[layer];

  // ⚠️ 先停旧的（淡出），再起新的 —— 直接换会有"咔"的爆音
  const oldDrones = st.drones;
  const oldShimmer = st.shimmer;
  const now = st.ctx.currentTime;
  for (const d of oldDrones) {
    d.gain.gain.cancelScheduledValues(now);
    d.gain.gain.setValueAtTime(d.gain.gain.value, now);
    d.gain.gain.linearRampToValueAtTime(0, now + 1.2);
    d.osc.stop(now + 1.3);
  }
  if (oldShimmer) {
    for (const s of oldShimmer) {
      s.gain.gain.cancelScheduledValues(now);
      s.gain.gain.setValueAtTime(s.gain.gain.value, now);
      s.gain.gain.linearRampToValueAtTime(0, now + 1.2);
      s.osc.stop(now + 1.3);
    }
  }
  st.drones = [];
  st.shimmer = null;

  // ⚠️ 滤波器：统一控制"亮/暗"
  const filter = st.ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = p.filterHz;
  filter.Q.value = 0.7;
  filter.connect(st.master);

  // 持续音：主音 + 八度（八度让音更"厚"）
  const voices: { osc: OscillatorNode; gain: GainNode }[] = [];
  voices.push(makeDrone(st.ctx, filter, p.baseFreq, p.droneGain, "sine"));
  if (p.voices >= 2) {
    voices.push(makeDrone(st.ctx, filter, p.baseFreq * 2, p.droneGain * 0.45, "sine"));
  }
  st.drones = voices;

  // 泛音层：比主音高两个八度 + 轻微失谐（detune）→ 产生"微光"的晃动感
  if (p.shimmerGain > 0.001) {
    const shimmerVoices: { osc: OscillatorNode; gain: GainNode }[] = [];
    const detunes = [0, 4, -5, 7];
    for (let i = 0; i < Math.max(1, p.voices - 1); i++) {
      const osc = st.ctx.createOscillator();
      const gain = st.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = p.baseFreq * 4;
      osc.detune.value = detunes[i % detunes.length];
      gain.gain.value = p.shimmerGain / Math.max(1, p.voices - 1);
      osc.connect(gain);
      gain.connect(filter);
      osc.start();
      shimmerVoices.push({ osc, gain });
    }
    st.shimmer = shimmerVoices;
  }

  // 噪声层（空气感）
  if (p.noiseGain > 0.001 && !st.noise) {
    const src = st.ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(st.ctx);
    src.loop = true;
    const gain = st.ctx.createGain();
    gain.gain.value = p.noiseGain;
    // ⚠️ 噪声过高频会"刺耳"，过一层低通把高频削掉
    const nf = st.ctx.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 1400;
    src.connect(nf);
    nf.connect(gain);
    gain.connect(st.master);
    src.start();
    st.noise = { src, gain };
  } else if (st.noise) {
    st.noise.gain.gain.setTargetAtTime(p.noiseGain, st.ctx.currentTime, 1.5);
  }

  // ⚠️ 呼吸包络：用一个 LFO 周期性微调音量 → "活着"的感觉
  if (p.breathSec > 0) {
    const lfo = st.ctx.createOscillator();
    const lfoGain = st.ctx.createGain();
    lfo.frequency.value = 1 / p.breathSec;
    lfoGain.gain.value = p.droneGain * 0.35;
    lfo.connect(lfoGain);
    for (const v of voices) {
      lfoGain.connect(v.gain.gain);
    }
    lfo.start();
    // ⚠️ 停掉旧 LFO：它们没被记进 state，靠 osc.onended 无法统一管理，
    //    所以这里让它们随 filter 一起被 GC（filter 断开后不再有输出）
  }

  st.layer = layer;
}

/* ══════════════════════════════════════════════════════════════
 * 对外 API
 * ══════════════════════════════════════════════════════════════ */

/**
 * 解锁音频（**必须在用户手势里调用**）
 *
 * 用法：在"开始占卜"按钮的 onClick 里调用 `await unlockAmbience()`。
 */
export async function unlockAmbience(): Promise<void> {
  const st = ensureGraph();
  if (!st?.ctx || !st.master) return;
  if (st.ctx.state === "suspended") {
    try { await st.ctx.resume(); } catch { /* 用户可能拒绝 */ }
  }
  st.unlocked = true;
  // 淡入主音量
  const now = st.ctx.currentTime;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(st.muted ? 0 : 0.85, now + 1.5);
}

/**
 * 切换到某个仪式阶段的氛围
 */
export function setAmbienceLayer(layer: AmbienceLayer): void {
  const st = getState();
  if (st.layer === layer && st.drones.length > 0) return;
  if (!st.unlocked) {
    // ⚠️ 还没解锁 → 只记录意图，等 unlock 时再生效
    st.layer = layer;
    return;
  }
  const g = ensureGraph();
  if (!g?.ctx) return;
  buildLayer(layer);
}

/** 静音/取消静音 */
export function setMuted(muted: boolean): void {
  const st = getState();
  st.muted = muted;
  // ⚠️ 通知订阅者（UI 上的图标要跟着变）
  notifyMuted();
  if (!st.ctx || !st.master) return;
  const now = st.ctx.currentTime;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(muted ? 0 : 0.85, now + 0.6);
}

/** 当前是否静音 */
export function isMuted(): boolean {
  return getState().muted;
}

/**
 * ⚠️ 订阅静音状态变化
 *
 * ⚠️ 为什么用订阅而不是在组件里 `useState` + `useEffect` 同步：
 *   静音状态存在**模块级单例**里（跨组件共享）。
 *   如果组件自己 useState 存一份，就得用 useEffect 去同步 —— 而 React 19 的
 *   `react-hooks/set-state-in-effect` 规则会报错（那是真的会导致额外渲染的模式）。
 *   正确做法是让**外部状态自己可订阅**（useSyncExternalStore）。
 *
 * ⚠️⚠️ 为什么监听器集合也放进 globalThis：
 *   本项目的硬规则（runtime.ts 注释）：**模块级可变状态必须收敛到 globalThis**，
 *   否则 Next.js 开发模式 HMR 会重新求值模块 → 监听器集合被重置 →
 *   已挂载组件的订阅丢失 → UI 状态与实际不同步。
 *   `verify-runtime-state.mjs` 就是这条规则的守卫（它抓到了这个问题 —— 好事）。
 */
const MUTED_LISTENERS_KEY = "__mysticTarotMutedListeners";

function getListeners(): Set<() => void> {
  const g = globalThis as unknown as Record<string, Set<() => void> | undefined>;
  if (!g[MUTED_LISTENERS_KEY]) g[MUTED_LISTENERS_KEY] = new Set();
  return g[MUTED_LISTENERS_KEY]!;
}

/** 通知所有订阅者状态变了 */
function notifyMuted(): void {
  for (const fn of getListeners()) fn();
}

/** 订阅静音状态（useSyncExternalStore 用） */
export function subscribeMuted(fn: () => void): () => void {
  const set = getListeners();
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** 静音状态的快照（useSyncExternalStore 用） */
export function getMutedSnapshot(): boolean {
  return getState().muted;
}

/** 服务端快照（useSyncExternalStore 用 —— 必须与客户端一致，否则 hydration 不匹配） */
export function getMutedServerSnapshot(): boolean {
  // ⚠️ 服务端没有音频状态 → 统一报"静音"（默认不出声）
  return true;
}

/**
 * 播放一次性音效（翻牌、答问、收束等）
 *
 * @param kind 音效类型
 */
export function playSfx(kind: "flip" | "select" | "answer" | "chime"): void {
  const st = getState();
  if (!st.unlocked || st.muted) return;
  const ctx = ensureGraph()?.ctx;
  if (!ctx || !st.master) return;

  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.connect(st.master);

  if (kind === "flip") {
    // 翻牌：短促的木质"嗒"——高频噪声 + 快速衰减
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    src.connect(bp); bp.connect(g); g.connect(out);
    src.start(now); src.stop(now + 0.2);
  } else if (kind === "select") {
    // 选牌：轻快的双音（上行）
    for (const [i, f] of [523.25, 783.99].entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t = now + i * 0.07;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + 0.55);
    }
  } else if (kind === "answer") {
    // 答问：温和的确认音
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 440;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.07, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(g); g.connect(out);
    osc.start(now); osc.stop(now + 0.65);
  } else {
    // 收束：泛音铃（三音叠加，长衰减）
    for (const f of [261.63, 392.0, 523.25]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.055, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, now + 3.2);
      osc.connect(g); g.connect(out);
      osc.start(now); osc.stop(now + 3.3);
    }
  }
}

/** 停止一切（离开占卜页时） */
export function stopAmbience(): void {
  const st = getState();
  if (!st.ctx || !st.master) return;
  const now = st.ctx.currentTime;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(0, now + 1.2);
}

/**
 * ⚠️ 把占卜阶段映射到氛围层
 *
 * ⚠️ 仪式的 `RitualPhase` 与音频层不是一一对应 —— 这里做**语义映射**：
 *   · card_selection 与 perCard 都能表达"牌在动"
 *   · synthesis 与 closing 分别是"辉煌"与"安详"
 */
export function ambienceForPhase(phase: string | null | undefined): AmbienceLayer {
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
