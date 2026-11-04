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
 *
 * ⚠️⚠️ 2026-11-04 大改（用户反馈"目前只是单纯的沙沙声"）：
 *   第一版只有 drone（持续音）+ 噪声（沙沙）+ 泛音 → 本质是"环境底噪"。
 *   这一版加入了**三层结构**：
 *     ① **乐句层**（arppeggio）—— 有旋律的音型，按阶段变化 ← "起伏音色"的来源
 *     ② **空间层**（混响 + 延迟）—— ConvolverNode + 程序化 IR ← "空灵"的来源
 *     ③ **事件层**（翻牌/揭示/阶段转换）—— 一次性音效，标记仪式节点
 *   并且：噪声层音量被大幅压低（0.012 → 0.004），不再抢戏。
 */

/* ══════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════ */

/** 占卜的仪式阶段 → 对应氛围层 */
export type AmbienceLayer =
  | "idle"        // 待机/首页：有旋律的等待（不再是纯底噪）
  | "contract"    // 承约：低沉、庄重
  | "invocation"  // 呼召三问：空灵、带泛音
  | "selection"   // 选牌：稀疏、留白多（制造等待的张力）
  | "perCard"     // 逐张讲牌：温暖、流动
  | "synthesis"   // 综合：开阔、辉煌
  | "closing";    // 收束：安详、渐弱

/**
 * 乐句（音型）—— 每个是一串音符
 *
 * ⚠️ 音符用**音名**表示（会转成频率），比直接写 Hz 好读：
 *   C=261.63, D=293.66, E=329.63, F=349.23, G=392.00, A=440.00, B=493.88
 *   小写 = 低八度，"#" = 升半音
 *
 * ⚠️ 为什么选这些音型（"空灵"的音乐语言）：
 *   · 自然小调（aeolian）：小调音阶，忧郁但不压抑 —— 占卜的底色
 *   · 洛克里亚（locrian）：含 b2 的减五度 → 有"不安/神秘"的色彩
 *   · 大调五声：明亮、空灵（像风铃）
 *   · 半减七和弦琶音：爵士里的"悬浮"感 → 适合"悬停"（等用户回答）
 */
interface Note {
  /** 音名，如 "A" "C#" "a"（小写=低八度） */
  p: string;
  /** 时值（相对单位，1 = 一拍） */
  d: number;
}

/** 每个氛围层的参数 */
interface LayerParams {
  /** 基频八度偏移（-1 降八度，0 原位，+1 升八度） */
  octave: number;
  /** drone 音量（0~1） */
  droneGain: number;
  /** 泛音层音量（0~1） */
  shimmerGain: number;
  /** 滤波截止频率（Hz） */
  filterHz: number;
  /** 呼吸包络周期（秒），0 = 不呼吸 */
  breathSec: number;
  /** 噪声层音量（0~1）—— ⚠️ 压得很低（第一版是 0.012，太抢戏） */
  noiseGain: number;
  /** 乐句层音量（0~1） */
  arpGain: number;
  /** 乐句音型 */
  arp: Note[];
  /** 乐句循环长度（拍） */
  arpLoopBeats: number;
  /** 每个拍的时长（秒） */
  beatSec: number;
  /** 混响干湿比（0~1） */
  reverbMix: number;
  /** 延迟干湿比（0~1） */
  delayMix: number;
}

const LAYER_PARAMS: Record<AmbienceLayer, LayerParams> = {
  // 待机/首页：大调五声琶音，缓慢、空灵 —— "有音乐的等待"
  idle: {
    octave: 0, droneGain: 0.040, shimmerGain: 0.012, filterHz: 900,
    breathSec: 9, noiseGain: 0.004, arpGain: 0.030,
    arp: [
      { p: "A", d: 2 }, { p: "C", d: 1 }, { p: "E", d: 1 },
      { p: "D", d: 2 }, { p: "C", d: 1 }, { p: "A", d: 1 },
    ],
    arpLoopBeats: 4, beatSec: 1.1, reverbMix: 0.55, delayMix: 0.22,
  },
  // 承约：A 自然小调下行，低沉庄重
  contract: {
    octave: -1, droneGain: 0.062, shimmerGain: 0.010, filterHz: 520,
    breathSec: 8, noiseGain: 0.004, arpGain: 0.026,
    arp: [
      { p: "A", d: 2 }, { p: "G", d: 1 }, { p: "E", d: 1 },
      { p: "C", d: 2 }, { p: "A", d: 1 }, { p: "a", d: 1 },
    ],
    arpLoopBeats: 4, beatSec: 1.35, reverbMix: 0.42, delayMix: 0.14,
  },
  // 呼召：Am 分解和弦，空灵飘忽
  invocation: {
    octave: 0, droneGain: 0.050, shimmerGain: 0.026, filterHz: 1100,
    breathSec: 7, noiseGain: 0.005, arpGain: 0.034,
    arp: [
      { p: "A", d: 1.5 }, { p: "C", d: 0.5 }, { p: "E", d: 1 }, { p: "A", d: 1 },
      { p: "G", d: 1.5 }, { p: "E", d: 0.5 }, { p: "C", d: 1 }, { p: "D", d: 1 },
    ],
    arpLoopBeats: 4, beatSec: 1.2, reverbMix: 0.68, delayMix: 0.30,
  },
  // 选牌：稀疏、留白多 → 制造"等待你出手"的张力
  selection: {
    octave: 0, droneGain: 0.046, shimmerGain: 0.020, filterHz: 860,
    breathSec: 5, noiseGain: 0.004, arpGain: 0.028,
    arp: [
      { p: "D", d: 3 }, { p: "A", d: 1 },
      { p: "E", d: 3 }, { p: "B", d: 1 },
    ],
    arpLoopBeats: 4, beatSec: 1.5, reverbMix: 0.60, delayMix: 0.26,
  },
  // 讲牌：C 大调琶音，温暖流动
  perCard: {
    octave: 0, droneGain: 0.055, shimmerGain: 0.020, filterHz: 780,
    breathSec: 6, noiseGain: 0.004, arpGain: 0.036,
    arp: [
      { p: "C", d: 1 }, { p: "E", d: 1 }, { p: "G", d: 1 }, { p: "B", d: 1 },
      { p: "A", d: 1 }, { p: "G", d: 1 }, { p: "F", d: 1 }, { p: "E", d: 1 },
    ],
    arpLoopBeats: 4, beatSec: 0.85, reverbMix: 0.48, delayMix: 0.18,
  },
  // 综合：Am-F-C-G 层层堆叠，开阔
  synthesis: {
    octave: 0, droneGain: 0.058, shimmerGain: 0.032, filterHz: 1500,
    breathSec: 9, noiseGain: 0.005, arpGain: 0.042,
    arp: [
      { p: "A", d: 1 }, { p: "C", d: 1 }, { p: "E", d: 2 },
      { p: "F", d: 1 }, { p: "A", d: 1 }, { p: "C", d: 2 },
      { p: "C", d: 1 }, { p: "E", d: 1 }, { p: "G", d: 2 },
      { p: "A", d: 1 }, { p: "G", d: 1 }, { p: "E", d: 2 },
    ],
    arpLoopBeats: 4, beatSec: 0.75, reverbMix: 0.62, delayMix: 0.24,
  },
  // 收束：Am 琶音渐弱，落回主音
  closing: {
    octave: -1, droneGain: 0.042, shimmerGain: 0.014, filterHz: 620,
    breathSec: 10, noiseGain: 0.003, arpGain: 0.026,
    arp: [
      { p: "A", d: 2 }, { p: "C", d: 1 }, { p: "E", d: 1 },
      { p: "C", d: 2 }, { p: "A", d: 1 }, { p: "a", d: 1 },
    ],
    arpLoopBeats: 4, beatSec: 1.45, reverbMix: 0.70, delayMix: 0.28,
  },
};

/* ══════════════════════════════════════════════════════════════
 * 音名 → 频率
 * ══════════════════════════════════════════════════════════════ */

const NOTE_BASE: Record<string, number> = {
  C: 261.63, "C#": 277.18, D: 293.66, "D#": 311.13,
  E: 329.63, F: 349.23, "F#": 369.99, G: 392.00,
  "G#": 415.30, A: 440.00, "A#": 466.16, B: 493.88,
};

/** 音名 → 频率（Hz）。小写字母 = 低八度。 */
function noteToFreq(name: string, octaveOffset = 0): number {
  const isLow = name[0] === name[0]?.toLowerCase();
  const key = name.toUpperCase();
  const base = NOTE_BASE[key] ?? 440;
  const oct = (isLow ? -1 : 0) + octaveOffset;
  return base * Math.pow(2, oct);
}

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
  /** 主音量（用户可调，0~1） */
  master: GainNode | null;
  /** 干/湿总线：dry → master，wet(reverb) → master */
  dry: GainNode | null;
  wet: GainNode | null;
  /** 混响器 */
  convolver: ConvolverNode | null;
  /** 延迟器 */
  delay: DelayNode | null;
  /** 持续音 */
  drones: { osc: OscillatorNode; gain: GainNode }[];
  /** 泛音层 */
  shimmer: { osc: OscillatorNode; gain: GainNode }[] | null;
  /** 噪声层 */
  noise: { src: AudioBufferSourceNode; gain: GainNode } | null;
  /** 当前层 */
  layer: AmbienceLayer;
  /** 用户音量（0~1，UI 滑块） */
  volume: number;
  /** 用户是否手动静音 */
  muted: boolean;
  /** 是否已解锁（用户手势发生过） */
  unlocked: boolean;
  /** 乐句调度器 */
  scheduler: { timer: number | null; nextNoteTime: number; noteIndex: number } | null;
  /** 当前乐句层参数（调度器要用） */
  arpParams: { notes: Note[]; beatSec: number; loopBeats: number; gain: number; octave: number } | null;
}

const STATE_KEY = "__mysticTarotAmbience";

function getState(): AmbienceState {
  const g = globalThis as unknown as Record<string, AmbienceState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      ctx: null, master: null, dry: null, wet: null, convolver: null, delay: null,
      drones: [], shimmer: null, noise: null,
      layer: "idle", volume: 0.3, muted: true, unlocked: false,
      scheduler: null, arpParams: null,
    };
  }
  return g[STATE_KEY]!;
}

/* ══════════════════════════════════════════════════════════════
 * 空间层（混响 / 延迟）
 * ══════════════════════════════════════════════════════════════ */

/**
 * 生成混响的脉冲响应（IR）
 *
 * ⚠️ **程序化生成，无需音频文件** —— 这是"空灵"感的关键。
 *   原理：IR 是一段"声音在房间里反弹"的录音。
 *   合成一个**指数衰减的噪声**就能得到一个不错的"大空间"。
 * ⚠️ 时长越长 = 空间越大越空灵（代价：CPU 与内存）。
 *   2.6 秒是个平衡点（再长会糊，再短会"干"）。
 */
function makeImpulseResponse(ctx: AudioContext, seconds = 2.6, decay = 2.6): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      // ⚠️ 指数衰减包络 × 随机噪声
      const env = Math.pow(1 - i / len, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return ir;
}

/**
 * 粉噪声缓冲（1 秒，循环用）
 *
 * ⚠️ 粉噪声（Voss-McCartney 简化版）比白噪声柔和得多，
 *    白噪声听起来像"沙沙"的电流声，粉噪声更像"风/空气"。
 */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
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

/* ══════════════════════════════════════════════════════════════
 * 构建
 * ══════════════════════════════════════════════════════════════ */

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
 * 创建一个滤波器节点
 *
 * ⚠️ 滤波后的信号要**同时**送到 dry 与 wet（混响总线）。
 */
function makeFilter(ctx: AudioContext, dest: AudioNode, type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.connect(dest);
  return f;
}

/**
 * 创建/恢复音频图
 *
 * ⚠️ 必须由**用户手势**触发（否则被浏览器自动播放策略拦截）
 */
function ensureGraph(): AmbienceState | null {
  const st = getState();
  if (st.ctx) {
    if (st.ctx.state === "suspended") void st.ctx.resume();
    return st;
  }

  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;

  try {
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0; // 从 0 淡入，避免"啪"的一声
    master.connect(ctx.destination);

    // 干总线
    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);

    // 湿总线（混响）
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulseResponse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    convolver.connect(wet);
    wet.connect(master);

    // 延迟（空间纵深）
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.42;
    const delayFb = ctx.createGain();
    delayFb.gain.value = 0.34;
    const delayWet = ctx.createGain();
    delayWet.gain.value = 0.25;
    delay.connect(delayFb);
    delayFb.connect(delay);
    delay.connect(delayWet);
    delayWet.connect(master);

    st.ctx = ctx;
    st.master = master;
    st.dry = dry;
    st.wet = wet;
    st.convolver = convolver;
    st.delay = delay;
    st.unlocked = true;
    return st;
  } catch {
    return null;
  }
}

/** 让一个节点同时连到 dry 与 wet（混响） */
function connectBoth(st: AmbienceState, node: AudioNode, reverbMix: number): void {
  node.connect(st.dry!);
  if (st.convolver && reverbMix > 0.01) {
    const send = st.ctx!.createGain();
    send.gain.value = reverbMix;
    node.connect(send);
    send.connect(st.convolver);
  }
}

/* ══════════════════════════════════════════════════════════════
 * 乐句调度器（lookahead scheduler）
 * ══════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 为什么用"前瞻调度器"而不是 setTimeout 逐个排音符：
 *   setTimeout 的实际触发时间会抖动（几十 ms）→ 节奏不稳，听起来很业余。
 *   前瞻调度器的做法：
 *     · 每 25ms 检查一次"下一个音符该在什么时候响"
 *     · 提前 120ms 就把音符**排进 Web Audio 的时间轴**（精确到采样）
 *     · JS 的定时器抖动**不影响**已经排好的音符
 */
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;

function startScheduler(st: AmbienceState): void {
  stopScheduler(st);
  const params = st.arpParams;
  if (!params || !st.ctx) return;

  const ctx = st.ctx;
  st.scheduler = {
    timer: window.setInterval(() => {
      const s = st.scheduler;
      const p = st.arpParams;
      if (!s || !p || !st.ctx) return;
      const now = st.ctx.currentTime;
      // ⚠️ 循环音型：noteIndex 走到末尾就回 0
      const note = p.notes[s.noteIndex % p.notes.length];
      const dur = note.d * p.beatSec;
      // ⚠️ 音符时长不能超过循环长度的一半（否则会重叠成噪音）
      const playDur = Math.min(dur * 0.92, p.loopBeats * p.beatSec * 0.5);

      if (s.nextNoteTime < now + SCHEDULE_AHEAD) {
        playArpNote(st, note.p, p.octave, s.nextNoteTime, playDur, p.gain);
        s.nextNoteTime += dur;
        s.noteIndex++;
      }
      // ⚠️ 兜底：如果卡了太久（标签页被挂起），把时间轴拉回来
      if (s.nextNoteTime < now) s.nextNoteTime = now + 0.05;
    }, LOOKAHEAD_MS),
    nextNoteTime: ctx.currentTime + 0.08,
    noteIndex: 0,
  };
}

function stopScheduler(st: AmbienceState): void {
  if (st.scheduler?.timer != null) {
    window.clearInterval(st.scheduler.timer);
    st.scheduler = null;
  }
}

/** 播一个乐句音符（三角波 + ADSR 包络） */
function playArpNote(
  st: AmbienceState,
  pitch: string,
  octaveOffset: number,
  when: number,
  dur: number,
  gainValue: number
): void {
  const ctx = st.ctx;
  if (!ctx || !st.dry) return;

  const freq = noteToFreq(pitch, octaveOffset);
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = freq;

  const g = ctx.createGain();
  // ⚠️ ADSR：attack 0.02s（不"啪"）/ decay 0.35s / sustain / release
  const attack = 0.02;
  const decay = 0.35;
  const sustainLevel = gainValue * 0.45;
  const release = Math.min(1.4, dur * 0.9);

  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainValue), when + attack);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustainLevel), when + attack + decay);
  g.gain.setValueAtTime(Math.max(0.0001, sustainLevel), when + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur + release);

  // ⚠️ 轻微低通：削掉三角波的尖锐高频，听起来更"柔"
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3200;

  osc.connect(lp);
  lp.connect(g);
  connectBoth(st, g, 0.6);
  osc.start(when);
  osc.stop(when + dur + release + 0.05);
}

/* ══════════════════════════════════════════════════════════════
 * 层次构建
 * ══════════════════════════════════════════════════════════════ */

/** 重建某一层的持续音 */
function buildLayer(layer: AmbienceLayer): void {
  const st = getState();
  if (!st.ctx || !st.master) return;
  const p = LAYER_PARAMS[layer];

  // ⚠️ 先停旧的（淡出），再起新的 —— 直接换会有"咔"的爆音
  const now = st.ctx.currentTime;
  for (const d of st.drones) {
    d.gain.gain.cancelScheduledValues(now);
    d.gain.gain.setValueAtTime(d.gain.gain.value, now);
    d.gain.gain.linearRampToValueAtTime(0, now + 1.2);
    d.osc.stop(now + 1.3);
  }
  if (st.shimmer) {
    for (const s of st.shimmer) {
      s.gain.gain.cancelScheduledValues(now);
      s.gain.gain.setValueAtTime(s.gain.gain.value, now);
      s.gain.gain.linearRampToValueAtTime(0, now + 1.2);
      s.osc.stop(now + 1.3);
    }
  }
  st.drones = [];
  st.shimmer = null;
  stopScheduler(st);

  // 统一滤波器（控制"亮/暗"）
  const filter = makeFilter(st.ctx, st.dry!, "lowpass", p.filterHz);
  connectBoth(st, filter, p.reverbMix);

  // 持续音：主音 + 八度（八度让音更"厚"）
  const voices = [makeDrone(st.ctx, filter, noteToFreq("A", p.octave), p.droneGain, "sine")];
  voices.push(makeDrone(st.ctx, filter, noteToFreq("A", p.octave + 1), p.droneGain * 0.4, "sine"));
  st.drones = voices;

  // 泛音层：比主音高两个八度 + 轻微失谐 → "微光"的晃动感
  if (p.shimmerGain > 0.001) {
    const shimmerVoices: { osc: OscillatorNode; gain: GainNode }[] = [];
    const detunes = [0, 4, -5, 7];
    for (let i = 0; i < 3; i++) {
      const osc = st.ctx.createOscillator();
      const gain = st.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = noteToFreq("A", p.octave + 2);
      osc.detune.value = detunes[i];
      gain.gain.value = p.shimmerGain / 3;
      osc.connect(gain);
      gain.connect(filter);
      osc.start();
      shimmerVoices.push({ osc, gain });
    }
    st.shimmer = shimmerVoices;
  }

  // 噪声层（空气感）—— ⚠️ 音量压得很低（0.003~0.005），不再抢戏
  if (p.noiseGain > 0.001 && !st.noise) {
    const src = st.ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(st.ctx);
    src.loop = true;
    const gain = st.ctx.createGain();
    gain.gain.value = p.noiseGain;
    const nf = st.ctx.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 1200;
    src.connect(nf);
    nf.connect(gain);
    gain.connect(st.master);
    src.start();
    st.noise = { src, gain };
  } else if (st.noise) {
    st.noise.gain.gain.setTargetAtTime(p.noiseGain, st.ctx.currentTime, 1.5);
  }

  // 混响/延迟的干湿比
  if (st.convolver && st.wet) {
    st.wet.gain.setTargetAtTime(p.reverbMix, st.ctx.currentTime, 1.2);
  }

  // 呼吸包络（LFO 调制 drone 音量）→ "活着"的感觉
  if (p.breathSec > 0) {
    const lfo = st.ctx.createOscillator();
    const lfoGain = st.ctx.createGain();
    lfo.frequency.value = 1 / p.breathSec;
    lfoGain.gain.value = p.droneGain * 0.35;
    lfo.connect(lfoGain);
    for (const v of voices) lfoGain.connect(v.gain.gain);
    lfo.start();
  }

  // 乐句层：交给前瞻调度器
  st.arpParams = {
    notes: p.arp,
    beatSec: p.beatSec,
    loopBeats: p.arpLoopBeats,
    gain: p.arpGain,
    octave: p.octave,
  };
  startScheduler(st);

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
  // 淡入主音量（用用户设置的音量）
  const now = st.ctx.currentTime;
  const target = st.muted ? 0 : st.volume;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(target, now + 1.5);
  // ⚠️ 乐句调度器在 unlock 前没启动 → 这里补上
  if (st.arpParams && !st.scheduler) startScheduler(st);
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
  notifyMuted();
  if (!st.ctx || !st.master) return;
  const now = st.ctx.currentTime;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(muted ? 0 : st.volume, now + 0.6);
}

/**
 * 设置音量（0~1）
 *
 * ⚠️ 用户明确要求"提供滑块"——所以音量必须是**独立于静音**的状态：
 *   静音 = 开关（记忆与否由上层决定）；音量 = 滑块（0~100%）。
 */
export function setVolume(volume: number): void {
  const st = getState();
  const v = Math.max(0, Math.min(1, volume));
  st.volume = v;
  notifyVolume();
  if (!st.ctx || !st.master || st.muted) return;
  const now = st.ctx.currentTime;
  st.master.gain.cancelScheduledValues(now);
  st.master.gain.setValueAtTime(st.master.gain.value, now);
  st.master.gain.linearRampToValueAtTime(v, now + 0.25);
}

/** 当前是否静音 */
export function isMuted(): boolean {
  return getState().muted;
}

/** 当前音量（0~1） */
export function getVolume(): number {
  return getState().volume;
}

/* ---- 订阅（给 useSyncExternalStore 用）---- */

/**
 * ⚠️ 为什么用订阅而不是在组件里 `useState` + `useEffect` 同步：
 *   静音/音量状态存在**模块级单例**里（跨组件共享）。
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
const VOLUME_LISTENERS_KEY = "__mysticTarotVolumeListeners";

function getListeners(key: string): Set<() => void> {
  const g = globalThis as unknown as Record<string, Set<() => void> | undefined>;
  if (!g[key]) g[key] = new Set();
  return g[key]!;
}

/** 通知所有订阅者状态变了 */
function notifyMuted(): void {
  for (const fn of getListeners(MUTED_LISTENERS_KEY)) fn();
}

function notifyVolume(): void {
  for (const fn of getListeners(VOLUME_LISTENERS_KEY)) fn();
}

/** 订阅静音状态（useSyncExternalStore 用） */
export function subscribeMuted(fn: () => void): () => void {
  const set = getListeners(MUTED_LISTENERS_KEY);
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** 订阅音量（useSyncExternalStore 用） */
export function subscribeVolume(fn: () => void): () => void {
  const set = getListeners(VOLUME_LISTENERS_KEY);
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** 静音状态的快照（useSyncExternalStore 用） */
export function getMutedSnapshot(): boolean {
  return getState().muted;
}

/** 音量的快照（useSyncExternalStore 用） */
export function getVolumeSnapshot(): number {
  return getState().volume;
}

/** 服务端快照（useSyncExternalStore 用 —— 必须与客户端一致，否则 hydration 不匹配） */
export function getMutedServerSnapshot(): boolean {
  // ⚠️ 服务端没有音频状态 → 统一报"静音"（默认不出声）
  return true;
}

/** 服务端音量快照（与客户端默认值一致） */
export function getVolumeServerSnapshot(): number {
  return 0.3;
}

/* ══════════════════════════════════════════════════════════════
 * 事件音效
 * ══════════════════════════════════════════════════════════════ */

/**
 * 播放一次性音效
 *
 * ⚠️ 2026-11-04 重做了全部音效：
 *   第一版的翻牌音是"带通噪声 1800Hz" → 听起来就是**沙沙**，
 *   完全没有"翻牌"的仪式感。
 *   新版翻牌 = 三层叠加：低频 thud（正弦下滑）+ 纸张摩擦 + 清脆铃。
 */
export function playSfx(kind: "flip" | "reveal" | "select" | "answer" | "chime" | "gong"): void {
  const st = getState();
  if (!st.unlocked || st.muted) return;
  const ctx = ensureGraph()?.ctx;
  if (!ctx || !st.master) return;

  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.connect(st.master);
  connectBoth(st, out, 0.5);

  if (kind === "flip") {
    // ── 翻牌：低频 thud + 纸张摩擦 + 清脆铃 ──
    // ① 低频下滑（120→60Hz）—— "啪"地翻开的手感
    const thud = ctx.createOscillator();
    const tg = ctx.createGain();
    thud.type = "sine";
    thud.frequency.setValueAtTime(120, now);
    thud.frequency.exponentialRampToValueAtTime(60, now + 0.18);
    tg.gain.setValueAtTime(0.22, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    thud.connect(tg);
    tg.connect(out);
    thud.start(now);
    thud.stop(now + 0.3);

    // ② 纸张摩擦（带通噪声，60ms）—— 卡片划过的质感
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(2600, now);
    bp.frequency.exponentialRampToValueAtTime(1500, now + 0.06);
    bp.Q.value = 1.6;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.09, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    src.start(now);
    src.stop(now + 0.1);

    // ③ 清脆铃（1240Hz，衰减快）—— "牌翻开了"的确认
    const bell = ctx.createOscillator();
    const bg = ctx.createGain();
    bell.type = "sine";
    bell.frequency.value = 1240;
    bg.gain.setValueAtTime(0.07, now + 0.01);
    bg.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    bell.connect(bg);
    bg.connect(out);
    bell.start(now + 0.01);
    bell.stop(now + 0.55);
  } else if (kind === "reveal") {
    // ── 牌面揭示：磬（三个泛音叠加 + 长混响尾）──
    // ⚠️ 这是整个仪式里**最重要的一下**（用户亲手翻开，牌面第一次显现）
    for (const [f, g0] of [[1046.5, 0.055], [1568.0, 0.032], [2093.0, 0.018]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(g0, now + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 2.4);
      osc.connect(g);
      g.connect(out);
      osc.start(now);
      osc.stop(now + 2.5);
    }
  } else if (kind === "select") {
    // 选牌：轻快的上行双音
    for (const [i, f] of [523.25, 783.99].entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      const t = now + i * 0.07;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 0.55);
    }
  } else if (kind === "answer") {
    // 答问：柔和确认音（两泛音 + 弱回声）
    for (const [f, g0] of [[440, 0.05], [660, 0.028]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(g0, now + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
      osc.connect(g);
      g.connect(out);
      osc.start(now);
      osc.stop(now + 0.75);
    }
  } else if (kind === "gong") {
    // ── 阶段转换：低沉锣（多失谐正弦 + 长衰减 + 大混响）──
    for (const [f, det] of [[110, -8], [110, 6], [164.8, 3], [220, -4]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.detune.value = det;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.035, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 3.0);
      osc.connect(g);
      g.connect(out);
      osc.start(now);
      osc.stop(now + 3.1);
    }
  } else {
    // 收束完成：下行琶音 + 长混响尾
    for (const [i, f] of [523.25, 392.0, 329.63, 261.63].entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      const t = now + i * 0.16;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 1.9);
    }
  }
}

/** 停止一切（离开占卜页时） */
export function stopAmbience(): void {
  const st = getState();
  stopScheduler(st);
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
