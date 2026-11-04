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

/**
 * 每个氛围层的参数
 *
 * ⚠️⚠️ 2026-11-04 三改（用户反馈「还是很长很长的空鸣声，特别刺耳」）：
 *   彻底移除 droneGain / shimmerGain / breathSec —— **持续音就是空鸣本身**。
 *   真正的冥想音乐（Calm / Insight Timer 的音景，Marconi Union《Weightless》）
 *   没有任何持续音：底床是自然噪声（风/水），旋律是稀疏的短音，音与音之间大量留白。
 *   → 本表只剩：噪声底床 + 稀疏乐句 + 空间感。
 */
interface LayerParams {
  /** 基频八度偏移（-1 降八度，0 原位，+1 升八度） */
  octave: number;
  /** 滤波截止频率（Hz）—— 只作用于噪声底床 */
  filterHz: number;
  /** 噪声层音量（0~1）—— 底床（风/空气感） */
  noiseGain: number;
  /** 乐句层音量（0~1） */
  arpGain: number;
  /** 乐句音型 */
  arp: Note[];
  /** 乐句循环长度（拍） */
  arpLoopBeats: number;
  /** 每个拍的时长（秒） */
  beatSec: number;
  /** 混响干湿比（0~1）—— ⚠️ 上限 0.5：大混响会把短音拖成"嗡鸣" */
  reverbMix: number;
  /** 延迟干湿比（0~1）—— 2026-11-04 起真正接线（此前只定义未生效） */
  delayMix: number;
}

const LAYER_PARAMS: Record<AmbienceLayer, LayerParams> = {
  // ⚠️ 音型设计原则（对齐冥想音乐）：
  //   · 音符更少、间隔更长（d 值大 = 留白多）→ "偶尔一声"而不是"连绵不断"
  //   · 每层一个循环 6~8 拍，但只有 2~5 个音 → 大部分时间是安静的
  // 待机/首页：风声底床 + 偶尔一声风铃般的五声短句
  idle: {
    octave: 0, filterHz: 900,
    noiseGain: 0.004, arpGain: 0.030,
    arp: [
      { p: "A", d: 4 }, { p: "C", d: 2 }, { p: "E", d: 2 },
    ],
    arpLoopBeats: 8, beatSec: 1.1, reverbMix: 0.45, delayMix: 0.18,
  },
  // 承约：更暗更低，低音区偶尔一声
  contract: {
    octave: -1, filterHz: 520,
    noiseGain: 0.004, arpGain: 0.026,
    arp: [
      { p: "A", d: 4 }, { p: "G", d: 2 }, { p: "E", d: 2 },
    ],
    arpLoopBeats: 8, beatSec: 1.35, reverbMix: 0.35, delayMix: 0.12,
  },
  // 呼召：Am 分解，但每音之间隔一拍以上的空
  invocation: {
    octave: 0, filterHz: 1100,
    noiseGain: 0.005, arpGain: 0.034,
    arp: [
      { p: "A", d: 3 }, { p: "E", d: 2 }, { p: "C", d: 3 },
    ],
    arpLoopBeats: 8, beatSec: 1.2, reverbMix: 0.48, delayMix: 0.22,
  },
  // 选牌：极稀疏 —— 制造"等待你出手"的张力
  selection: {
    octave: 0, filterHz: 860,
    noiseGain: 0.004, arpGain: 0.028,
    arp: [
      { p: "D", d: 6 }, { p: "A", d: 2 },
    ],
    arpLoopBeats: 8, beatSec: 1.5, reverbMix: 0.40, delayMix: 0.16,
  },
  // 讲牌：稍流动一点，但仍是"点"状
  perCard: {
    octave: 0, filterHz: 780,
    noiseGain: 0.004, arpGain: 0.036,
    arp: [
      { p: "C", d: 2 }, { p: "E", d: 2 }, { p: "G", d: 3 }, { p: "B", d: 1 },
    ],
    arpLoopBeats: 8, beatSec: 0.85, reverbMix: 0.42, delayMix: 0.15,
  },
  // 综合：最丰富的一层（仪式高潮），但也只是 5 个音/8 拍
  synthesis: {
    octave: 0, filterHz: 1500,
    noiseGain: 0.005, arpGain: 0.042,
    arp: [
      { p: "A", d: 2 }, { p: "C", d: 2 }, { p: "E", d: 3 },
      { p: "G", d: 2 }, { p: "A", d: 3 },
    ],
    arpLoopBeats: 8, beatSec: 0.75, reverbMix: 0.50, delayMix: 0.20,
  },
  // 收束：安详，落回主音
  closing: {
    octave: -1, filterHz: 620,
    noiseGain: 0.003, arpGain: 0.026,
    arp: [
      { p: "A", d: 4 }, { p: "C", d: 2 }, { p: "a", d: 2 },
    ],
    arpLoopBeats: 8, beatSec: 1.45, reverbMix: 0.45, delayMix: 0.18,
  },
};

/* ══════════════════════════════════════════════════════════════
 * 音色常量
 * ══════════════════════════════════════════════════════════════ */

/**
 * ⚠️ 乐句的音色（2026-11-04）
 *
 * ⚠️ 为什么是 **sine** 而不是 triangle：
 *   三角波的谐波结构（基频 + 奇次谐波）非常像**簧片乐器**
 *   （长笛 / 单簧管 / 萨克斯）→ 用户一听就喊"长笛，很吵"。
 *   正弦波只有基频 → 干净、柔和、空灵。
 *   ⚠️ 代价：纯正弦略闷 → 用**两个微失谐的正弦**叠出一点空气感。
 */
const ARP_WAVE: OscillatorType = "sine";
/** 微失谐（cents）—— 小到人耳几乎无拍频，但音色不呆板 */
const ARP_DETUNE = 3;

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
  /** 延迟湿线的发送增益（2026-11-04 起按层接线 delayMix） */
  delayWet: GainNode | null;
  /**
   * ⚠️ 噪声层（唯一的持续声源，无固定音高 → 不产生"鸣"）
   * ⚠️ 2026-11-04 三改：顺带存下低通滤波器 —— 切层时需要改 filterHz（底床明暗）
   */
  noise: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null;
  /** 当前层 */
  layer: AmbienceLayer;
  /** 用户音量（0~1，UI 滑块） */
  volume: number;
  /** 用户是否手动静音 */
  muted: boolean;
  /** 是否已解锁（用户手势发生过） */
  unlocked: boolean;
  /** 乐句调度器 */
  scheduler: { timer: number | null; nextNoteTime: number; noteIndex: number; active: boolean } | null;
  /** 当前乐句层参数（调度器要用） */
  arpParams: { notes: Note[]; beatSec: number; loopBeats: number; gain: number; octave: number } | null;
}

const STATE_KEY = "__mysticTarotAmbience";

function getState(): AmbienceState {
  const g = globalThis as unknown as Record<string, AmbienceState | undefined>;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      ctx: null, master: null, dry: null, wet: null, convolver: null, delay: null, delayWet: null,
      noise: null,
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
 * ⚠️ 2026-11-04 三改：2.6s → 1.6s。
 *   原因（用户反馈「很长很长的空鸣声」）：IR 太长 = 每个音都被拖成长尾，
 *   连续的音互相叠加尾巴 = 一片"嗡——"。真实冥想音乐的空间感是"清晰的大房间"，
 *   不是"无尽的山洞"。
 */
function makeImpulseResponse(ctx: AudioContext, seconds = 1.6, decay = 2.6): AudioBuffer {
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

/**
 * ⚠️ 2026-11-04 三改：makeDrone / makeFilter 已删除（drone 体系整体移除，
 *   makeFilter 的唯一调用方也在 buildLayer 里随 drone 一起删了）。
 *   噪声底床的滤波直接内联在 buildLayer 的噪声链里。
 */

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
    // ⚠️ 2026-11-04：delayWet 存进状态 → 每层可以有自己的 delayMix
    //   （此前 delayWet 是局部变量、写死 0.25，LAYER_PARAMS.delayMix 从未生效）
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.42;
    const delayFb = ctx.createGain();
    // ⚠️ 2026-11-04 三改：反馈 0.34 → 0.18。
    //   反馈越高，同一个音被重复的次数越多（0.34 约重复 3 次），
    //   稀疏的音叠起来 = "嗡嗡的复读"。0.18 只留一两次极轻的回声。
    delayFb.gain.value = 0.18;
    const delayWet = ctx.createGain();
    delayWet.gain.value = 0.2;
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
    st.delayWet = delayWet;
    st.unlocked = true;
    return st;
  } catch {
    return null;
  }
}

/**
 * 让一个节点同时连到 dry 与 wet（混响）
 *
 * ⚠️ 2026-11-04 三改：额外接入延迟（echo）发送。
 *   原实现里 delay 节点**只有反馈环和输出、没有任何输入** ——
 *   也就是说 delayMix 一直是个死参数、延迟从未真正生效。
 *   现在把音符的一部分送进延迟 → 稀疏的音才有"远处的回声"（空间纵深）。
 *   ⚠️ 送进延迟的量刻意很小（DELAY_SEND）—— 回声太多会变成"嗡嗡的复读"。
 */
function connectBoth(st: AmbienceState, node: AudioNode, reverbMix: number): void {
  node.connect(st.dry!);
  if (st.convolver && reverbMix > 0.01) {
    const send = st.ctx!.createGain();
    send.gain.value = reverbMix;
    node.connect(send);
    send.connect(st.convolver);
  }
  if (st.delay && st.delayWet) {
    const dSend = st.ctx!.createGain();
    dSend.gain.value = DELAY_SEND;
    node.connect(dSend);
    dSend.connect(st.delay);
  }
}

/** 送进延迟（回声）的量 —— 刻意很小，只是"远处的一点回响" */
const DELAY_SEND = 0.22;

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
      if (!s || !p || !st.ctx || !s.active) return;
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
    /**
     * ⚠️ active：早退判断用（见 setAmbienceLayer）。
     *   drone 删除后，"层是否活着"不能再看 st.drones.length —— 看调度器。
     */
    active: true,
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

  /**
   * ⚠️⚠️ 2026-11-04 重做（用户反馈："长笛一样的声音，很吵，叮——————"）
   *
   * ⚠️ 那个"叮——————"是三重叠加造成的：
   *   ① **三角波**的谐波结构像簧片乐器（长笛/单簧管）→ 一听就是"长笛"
   *   ② **sustain 段持续**（gain×0.45）+ **release 长达 1.4s** → 音被"拉长"
   *   ③ **失谐泛音层**（±4~7 cents）→ 拍频产生"金属颤音" → 更吵
   *
   * ⚠️ 修法：
   *   ① 三角波 → **正弦波**（只有基频，没有刺耳谐波）
   *      ⚠️ 代价是偏闷 → 用**两个正弦微失谐**叠一点"空气感"（±3 cents，
   *         人耳几乎听不出拍频，但音色不呆板）
   *   ② 包络改成**"拨弦式"**：快速 attack → 快速衰减 → **几乎无 sustain**
   *      → 每个音是"点"出来的，不是"拉"出来的 → 不再有"叮————"
   *   ③ release 大幅缩短（1.4s → 0.5s）
   *
   * ⚠️ 目标：**神秘、柔和、有起伏**。
   *    神秘感来自**混响 + 稀疏音型**，不是来自响亮的长音。
   */
  const g = ctx.createGain();
  const attack = 0.015;
  const decay = 0.28;
  // ⚠️ sustain 压到几乎为零 → "点"出来的音，不是"拉"出来的音
  const sustainLevel = gainValue * 0.06;
  const release = 0.5;

  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainValue), when + attack);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustainLevel), when + attack + decay);
  g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay + release);

  // ⚠️ 轻微低通：给正弦波加一点"空气"，同时削掉任何尖锐成分
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 2400;
  lp.Q.value = 0.5;

  // ⚠️ 两个微失谐的正弦叠加（±3 cents）—— 比三角波柔，但不死板
  for (const det of [-ARP_DETUNE, ARP_DETUNE]) {
    const osc = ctx.createOscillator();
    osc.type = ARP_WAVE;
    osc.frequency.value = freq;
    osc.detune.value = det;
    osc.connect(lp);
    osc.start(when);
    osc.stop(when + attack + decay + release + 0.05);
  }

  lp.connect(g);
  // ⚠️ 2026-11-04 三改：混响量改为跟随当前层（原来写死 0.6，会盖掉每层的 reverbMix）
  connectBoth(st, g, LAYER_PARAMS[st.layer]?.reverbMix ?? 0.4);
}

/* ══════════════════════════════════════════════════════════════
 * 层次构建
 * ══════════════════════════════════════════════════════════════ */

/**
 * 重建某一层的声景
 *
 * ⚠️⚠️ 2026-11-04 三改：整个"持续音"体系（drone + shimmer + 呼吸 LFO）被移除。
 *   原因（用户反馈「很长很长的空鸣声，特别刺耳」）：
 *   · 两个永不停止的正弦（A + A 高八度）= 持续纯音，听觉系统把它当"信号测试音"
 *   · shimmer 再叠 3 个 A+2 八度（≈1760Hz）的持续正弦 —— 刺耳的主体
 *   · 它们还灌进 2.6s 大混响 → 拖成一片"嗡——"
 *   真正的冥想音乐没有持续音。现在的层 = 噪声底床 + 稀疏乐句（调度器）。
 */
function buildLayer(layer: AmbienceLayer): void {
  const st = getState();
  if (!st.ctx || !st.master) return;
  const p = LAYER_PARAMS[layer];

  // ⚠️ 切层时先停旧调度器（旧的乐句尾音自然衰减，不硬切 → 无爆音）
  stopScheduler(st);

  // 噪声底床（风/空气感 —— 无固定音高，永不产生"鸣"）
  // ⚠️ 2026-11-04 三改：底床的明暗（filterHz）现在真的随层切换 ——
  //    之前 filterHz 只作用在已被删除的 drone 链上，噪声永远是固定 1200Hz。
  if (st.noise) {
    // 已存在 → 改音量与明暗（不用重建，避免任何咔哒声）
    st.noise.gain.gain.setTargetAtTime(p.noiseGain, st.ctx.currentTime, 1.5);
    st.noise.filter.frequency.setTargetAtTime(p.filterHz, st.ctx.currentTime, 1.5);
  } else if (p.noiseGain > 0.001) {
    const src = st.ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(st.ctx);
    src.loop = true;
    const gain = st.ctx.createGain();
    gain.gain.value = p.noiseGain;
    const nf = st.ctx.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = p.filterHz;
    src.connect(nf);
    nf.connect(gain);
    gain.connect(st.master);
    src.start();
    st.noise = { src, gain, filter: nf };
  }

  // 混响/延迟的干湿比（⚠️ delayMix 2026-11-04 起真正接线）
  if (st.convolver && st.wet) {
    st.wet.gain.setTargetAtTime(p.reverbMix, st.ctx.currentTime, 1.2);
  }
  if (st.delayWet) {
    st.delayWet.gain.setTargetAtTime(p.delayMix, st.ctx.currentTime, 1.2);
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
  //   （buildLayer 只在 setAmbienceLayer 且已解锁时才建层；
  //    「先解锁但还没切层」的场景由这里兜底）
  if (st.arpParams && !st.scheduler) startScheduler(st);
  else if (st.scheduler) st.scheduler.active = true;
}

/**
 * 切换到某个仪式阶段的氛围
 */
export function setAmbienceLayer(layer: AmbienceLayer): void {
  const st = getState();
  /**
   * ⚠️ 早退条件（2026-11-04 三改）：drone 删除后不能再用 st.drones.length。
   *   现在用「调度器活着」判断该层是否已在响 —— 调度器是乐句层的引擎，
   *   它活着 = 该层已在工作（噪声底床也随之建好）。
   */
  if (st.layer === layer && st.scheduler?.active) return;
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
    /**
     * ⚠️⚠️ 2026-11-04 重做（用户反馈："翻牌的那个叮的声音不够好听，
     *   可以换一个轻柔神秘的"）
     *
     * ⚠️ 原来的问题：铃是 **1240Hz 的正弦**（明亮、尖锐、有金属感）
     *   → 听起来像"叮！"（像门铃 / 手机提示音），与占卜氛围**完全冲突**。
     *
     * ⚠️ 新的设计（**木质轻叩 + 柔和泛音**，像手指拂过纸牌）：
     *   ① 木质叩击：正弦下滑（220→130Hz）+ 极短衰减 → "笃"的质感
     *   ② 纸张摩擦：带通噪声（2.6kHz→1.5kHz，55ms）→ 卡片划过的沙沙
     *   ③ 柔和泛音：两个**低八度**的正弦（587Hz / 880Hz，很轻）
     *      → ⚠️ **不用高频铃**（那正是"吵"的来源）
     *      → 低八度泛音有"神秘"的余韵，但绝不刺耳
     */
    // ① 木质叩击
    const thud = ctx.createOscillator();
    const tg = ctx.createGain();
    thud.type = "sine";
    thud.frequency.setValueAtTime(220, now);
    thud.frequency.exponentialRampToValueAtTime(130, now + 0.12);
    tg.gain.setValueAtTime(0.14, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thud.connect(tg);
    tg.connect(out);
    thud.start(now);
    thud.stop(now + 0.22);

    // ② 纸张摩擦（更短、更轻）
    const src = ctx.createBufferSource();
    src.buffer = makeNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(2600, now);
    bp.frequency.exponentialRampToValueAtTime(1500, now + 0.055);
    bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.055, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    src.start(now);
    src.stop(now + 0.09);

    // ③ 柔和泛音（低八度，很轻 —— 神秘但不刺耳）
    for (const [f, g0] of [[587.33, 0.032], [880.0, 0.018]] as const) {
      const osc = ctx.createOscillator();
      const bg = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      bg.gain.setValueAtTime(0, now + 0.008);
      bg.gain.linearRampToValueAtTime(g0, now + 0.02);
      bg.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
      osc.connect(bg);
      bg.connect(out);
      osc.start(now + 0.008);
      osc.stop(now + 0.8);
    }
  } else if (kind === "reveal") {
    // ── 牌面揭示：磬（三个泛音叠加 + 混响尾）──
    // ⚠️ 这是整个仪式里**最重要的一下**（用户亲手翻开，牌面第一次显现）
    // ⚠️ 2026-11-04：泛音从 1046/1568/2093Hz **整体降八度**到
    //    523/784/1046Hz —— 原来那组偏亮偏尖（"叮！"），
    //    降八度后是"钟"，有神秘余韵而不刺耳。
    // ⚠️ 2026-11-04 三改：衰减 2.4s → 1.2s。
    //    长衰减的金属泛音互相拖尾叠成"鸣"——这是「空鸣」的帮凶，
    //    真实磬在中等空间里的可闻尾音也就 1 秒上下。
    for (const [f, g0] of [[523.25, 0.05], [783.99, 0.028], [1046.5, 0.015]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(g0, now + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
      osc.connect(g);
      g.connect(out);
      osc.start(now);
      osc.stop(now + 1.3);
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
    // ── 阶段转换：低沉锣（多失谐正弦 + 衰减 + 混响）──
    // ⚠️ 2026-11-04 三改：衰减 3.0s → 1.2s。
    //    锣是"阶段开始的标记"，不是"持续音景"；
    //    3 秒的尾巴会跟下一个音叠成"嗡鸣"。
    for (const [f, det] of [[110, -8], [110, 6], [164.8, 3], [220, -4]] as const) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.detune.value = det;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.035, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
      osc.connect(g);
      g.connect(out);
      osc.start(now);
      osc.stop(now + 1.3);
    }
  } else {
    // 收束完成：下行琶音 + 混响尾
    // ⚠️ 2026-11-04 三改：尾巴 1.8s → 1.0s（同 gong/reveal 的理由：
    //    长衰减尾互相叠加 = "嗡鸣"）
    for (const [i, f] of [523.25, 392.0, 329.63, 261.63].entries()) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = f;
      const t = now + i * 0.16;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 1.1);
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
