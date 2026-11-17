/**
 * 配乐层 —— 7 段阶段曲目的加载、循环处理与交叉淡化
 *
 * ⚠️ 核心职责（只做这四件事）：
 *   ① **懒加载**：只有当前阶段的那一首会被 fetch（其余按需）
 *   ② **无缝循环**：把曲尾与曲首做等功率交叉淡化后拼回 → 真循环
 *   ③ **交叉淡化**：阶段切换时新旧两首重叠 3 秒 → 听感是"转段"不是"换歌"
 *   ④ **统一响度**：按离线测量出的 per-track 增益对齐 7 首的响度
 *
 * ⚠️⚠️ 为什么"无缝循环"必须在客户端做（而不是生成时就做好）：
 *   AI 出的曲子首尾**一定**接不上（除非生成模型专门处理过）。
 *   要得到真循环，唯一的办法是把曲尾 N 秒与曲首 N 秒交叉淡化后拼成一条更短的曲子。
 *   · 在 Node 里做 → 需要 MP3 解码器（本项目没有额外依赖）
 *   · 在浏览器里做 → `decodeAudioData` 原生支持，零依赖
 *   → 所以：客户端解码时顺手做掉，一次性成本，之后缓存复用。
 *
 * ⚠️ 为什么交叉淡化用**等功率**（sin²）而不是线性：
 *   两条不相关的音乐同时播放时，线性交叉淡化到中点会出现**响度塌陷**
 *   （两个半幅信号叠加 ≈ 0.707 倍 → 中间听起来"凹"了一下）。
 *   等功率曲线（sin²/cos²）保证总功率恒定 → 中点不掉音量。
 */

import { getEngine } from "./engine";
import { trackKey, trackUrl, type ScorePhase, type ScoreStyle } from "./phase";

/* ══════════════════════════════════════════════════════════════
 * 常量
 * ══════════════════════════════════════════════════════════════ */

/** 阶段切换的交叉淡化时长（秒） */
const CROSSFADE_SEC = 3;

/** 无缝循环的交叉淡化时长（秒） */
const LOOP_FADE_SEC = 3;

/** 离线测量给出的响度目标（LUFS）—— 仅用于文档与脚本对齐，运行时不用 */
export const TARGET_LUFS = -20;

/* ══════════════════════════════════════════════════════════════
 * 状态
 * ══════════════════════════════════════════════════════════════ */

interface ScoreSlot {
  /** 当前播放的 source（null = 空闲） */
  source: AudioBufferSourceNode | null;
  /** 该槽的增益节点 */
  gain: GainNode | null;
  /** 该槽正在播放的曲目 key */
  key: string | null;
}

interface ScoreState {
  /** 已解码并处理好的循环缓冲（key → buffer） */
  buffers: Map<string, AudioBuffer>;
  /** 正在加载中的曲目（key → promise），避免同一首并发 fetch */
  pending: Map<string, Promise<AudioBuffer | null>>;
  /** 两个交替使用的播放槽 */
  slots: [ScoreSlot, ScoreSlot];
  /** 当前活跃槽的下标 */
  activeSlot: 0 | 1;
  /** 正在播放的曲目 key（null = 没在播） */
  playingKey: string | null;
  /** 离线测量的响度修正表（key → dB） */
  manifest: Map<string, number>;
  /** 离线测得的音色修正（key → 低通截止 Hz），用来压掉过亮的曲子 */
  tone: Map<string, number>;
  /** manifest 是否已尝试加载过 */
  manifestLoaded: boolean;
}

const SCORE_KEY = "__mysticTarotScore";

function getScoreState(): ScoreState {
  const g = globalThis as unknown as Record<string, ScoreState | undefined>;
  if (!g[SCORE_KEY]) {
    g[SCORE_KEY] = {
      buffers: new Map(),
      pending: new Map(),
      slots: [
        { source: null, gain: null, key: null },
        { source: null, gain: null, key: null },
      ],
      activeSlot: 0,
      playingKey: null,
      manifest: new Map(),
      tone: new Map(),
      manifestLoaded: false,
    };
  }
  return g[SCORE_KEY]!;
}

/* ══════════════════════════════════════════════════════════════
 * 无缝循环处理
 * ══════════════════════════════════════════════════════════════ */

/**
 * 把一条曲子处理成**首尾相接的真循环**
 *
 * ⚠️⚠️ 这里的拼接方向极易搞反（我第一版就写反了）：
 *
 *   朴素做法「输出 = 主体 + 交叉淡化(尾, 头)」是**错的** ——
 *   那样头段 src[0..F-1] 会在交叉淡化里淡入一次、循环回到开头又播一次
 *   → 头段被播了两遍 → 而且循环接缝处是 src[F-1] → src[0] 的**倒退跳变**
 *   （把 3 秒前的音乐倒着跳回去，明显可闻）。
 *
 *   正确做法是**头段截断、尾段前移**：
 *     · 主体从 src[F] 开始（跳过已经在交叉淡化里淡入过的头段）
 *     · 交叉淡化区放在末尾：尾段淡出 + 头段淡入
 *     · 于是：out 的最后 ≈ src[F-1]，out 的第一 = src[F] → **正好接上**
 *
 *   验证（设 F 为淡化长度、N 为原长）：
 *     out[0]           = src[F]              （主体起点）
 *     out[N-2F]        = src[N-2F]            （主体与淡化区衔接，连续）
 *     out[N-F-1] ≈ src[F-1]                  （淡化区末尾 = 头段末尾）
 *     → 循环接缝 out[N-F-1] → out[0] = src[F-1] → src[F]  ✅ 连续
 *
 * ⚠️ 为什么用等功率（cos/sin）而不是线性：
 *   线性交叉淡化在接缝处会有约 3dB 的能量凹陷 → 循环时每轮出现一次"音量塌一下"。
 */
/**
 * ⚠️ 导出（export）：`scripts/dev/analyze-score.mjs` 要用**线上这一份**代码
 *   来测接缝 —— 复制一份到脚本里测，测的就不是线上跑的了（会漂移）。
 */
export function makeLoopable(buffer: AudioBuffer, ctx: BaseAudioContext, fadeSec = LOOP_FADE_SEC): AudioBuffer {
  const N = buffer.length;
  const F = Math.min(Math.floor(fadeSec * buffer.sampleRate), Math.floor(N / 3));
  if (F < 32) return buffer; // 太短，不处理

  const outLen = N - F;
  const out = ctx.createBuffer(buffer.numberOfChannels, outLen, buffer.sampleRate);
  const bodyEnd = N - 2 * F; // 主体与交叉淡化区的分界

  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    const dst = out.getChannelData(ch);

    // ① 主体：跳过已在淡化区淡入过的头段 F
    for (let i = 0; i < bodyEnd; i++) dst[i] = src[i + F];

    // ② 交叉淡化区：尾段淡出 + 头段淡入（等功率）
    for (let j = 0; j < F; j++) {
      const t = j / F;
      const tail = src[bodyEnd + j];
      const head = src[j];
      dst[bodyEnd + j] = tail * Math.cos((t * Math.PI) / 2) + head * Math.sin((t * Math.PI) / 2);
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
 * 增益自动化
 * ══════════════════════════════════════════════════════════════ */

/**
 * 等功率增益曲线
 *
 * ⚠️ 为什么用 `setValueCurveAtTime` 而不是 `linearRampToValueAtTime`：
 *   线性是**幅度**插值 → 两个不相关信号叠加时中间会掉音量（功率塌陷）
 *   sin² 曲线是**功率**插值 → 总功率恒定 → 中点不掉
 */
function rampEqualPower(param: AudioParam, from: number, to: number, start: number, dur: number): void {
  const N = 48;
  const curve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const s = Math.sin((t * Math.PI) / 2);
    curve[i] = from + (to - from) * s * s;
  }
  param.cancelScheduledValues(start);
  param.setValueAtTime(from, start);
  param.setValueCurveAtTime(curve, start, dur);
}

/* ══════════════════════════════════════════════════════════════
 * manifest（离线测量的响度修正）
 * ══════════════════════════════════════════════════════════════ */

/**
 * 加载 `public/audio/score.manifest.json`
 *
 * ⚠️ 为什么要有 manifest：
 *   AI 生成的 14 首曲子响度天然不一致（有的重有的轻）→ 切阶段时会有跳变。
 *   离线脚本逐首测出响度并算出需要的增益，写进 manifest。
 *   运行时按 manifest 缩放 → 7 首在听感上是**同一首曲子的 7 个段落**。
 *
 * ⚠️ 为什么加载失败也要能跑：manifest 是**优化**不是**依赖**
 *   → 拿不到就用 0 dB（原始音量），功能不受影响。
 */
async function loadManifest(): Promise<void> {
  const st = getScoreState();
  if (st.manifestLoaded) return;
  st.manifestLoaded = true;
  try {
    const res = await fetch("/audio/score.manifest.json", { cache: "no-cache" });
    if (!res.ok) return;
    const json = (await res.json()) as {
      tracks?: Record<string, { gainDb?: number; lowpassHz?: number }>;
    };
    for (const [key, meta] of Object.entries(json.tracks ?? {})) {
      if (typeof meta?.gainDb === "number") st.manifest.set(key, meta.gainDb);
      if (typeof meta?.lowpassHz === "number") st.tone.set(key, meta.lowpassHz);
    }
  } catch {
    /* manifest 是可选的 */
  }
}

/* ══════════════════════════════════════════════════════════════
 * 加载
 * ══════════════════════════════════════════════════════════════ */

async function loadTrack(style: ScoreStyle, phase: ScorePhase): Promise<AudioBuffer | null> {
  const st = getScoreState();
  const eng = getEngine();
  const ctx = eng.ctx;
  if (!ctx) return null;

  const key = trackKey(style, phase);

  const cached = st.buffers.get(key);
  if (cached) return cached;

  const inflight = st.pending.get(key);
  if (inflight) return inflight;

  const p = (async (): Promise<AudioBuffer | null> => {
    try {
      const res = await fetch(trackUrl(style, phase));
      if (!res.ok) return null;
      const raw = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(raw);
      const looped = makeLoopable(decoded, ctx);
      st.buffers.set(key, looped);
      return looped;
    } catch {
      // 缺失/解码失败 → 该层静音，其余层照常
      return null;
    } finally {
      st.pending.delete(key);
    }
  })();

  st.pending.set(key, p);
  return p;
}

/* ══════════════════════════════════════════════════════════════
 * 播放
 * ══════════════════════════════════════════════════════════════ */

function stopSlot(slot: ScoreSlot, when: number): void {
  if (!slot.source) return;
  try {
    slot.source.stop(when);
  } catch {
    /* 已经停了 */
  }
  slot.source = null;
  slot.gain = null;
  slot.key = null;
}

/**
 * 交叉淡化到新曲目
 */
function startCrossfade(buffer: AudioBuffer, key: string): void {
  const st = getScoreState();
  const eng = getEngine();
  const ctx = eng.ctx;
  const bus = eng.scoreBus;
  if (!ctx || !bus) return;

  const now = ctx.currentTime;
  const nextIdx: 0 | 1 = st.activeSlot === 0 ? 1 : 0;
  const next = st.slots[nextIdx];
  const cur = st.slots[st.activeSlot];

  // 目标槽：清掉旧的
  stopSlot(next, now);

  // 新曲开始
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true; // 关键：配合 makeLoopable 处理过的缓冲 → 真循环

  const gain = ctx.createGain();
  gain.gain.value = 0;

  /**
   * ⚠️ 音色修正（低通）
   *   AI 生成的曲子偏亮（频谱重心实测 1900~2764Hz 的都有 → 刺耳）。
   *   离线脚本按"风格中位数"给每首算了一个低通截止频率（见 score.manifest.json），
   *   这里按曲目挂上 → 7 首落在同一个音色区间 → 切阶段不会像"换了个乐器"。
   *   没有修正值的曲目 → 截止频率设到 20kHz（等于不处理）。
   */
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = st.tone.get(key) ?? 20000;
  tone.Q.value = 0.707;

  // 响度修正（manifest 的 per-track 增益）
  const gainDb = st.manifest.get(key) ?? 0;
  const scale = gainDb === 0 ? 1 : Math.pow(10, gainDb / 20);
  const post = ctx.createGain();
  post.gain.value = scale;

  src.connect(tone);
  tone.connect(gain);
  gain.connect(post);
  post.connect(bus);
  src.start(now);

  // 新曲淡入
  rampEqualPower(gain.gain, 0, 1, now, CROSSFADE_SEC);

  // 旧曲淡出（与新曲重叠 CROSSFADE_SEC 秒）
  if (cur.source && cur.gain) {
    rampEqualPower(cur.gain.gain, cur.gain.gain.value, 0, now, CROSSFADE_SEC);
    // 淡出结束后真正停掉（否则 source 会一直循环占用 CPU）
    try {
      cur.source.stop(now + CROSSFADE_SEC + 0.1);
    } catch {
      /* 已经停了 */
    }
  }

  next.source = src;
  next.gain = gain;
  next.key = key;
  st.activeSlot = nextIdx;
  st.playingKey = key;
}

/** 停止配乐（淡出） */
export function stopScore(): void {
  const st = getScoreState();
  const eng = getEngine();
  if (!eng.ctx) {
    st.playingKey = null;
    return;
  }
  const now = eng.ctx.currentTime;
  for (const slot of st.slots) {
    if (slot.source && slot.gain) {
      rampEqualPower(slot.gain.gain, slot.gain.gain.value, 0, now, 0.8);
      try {
        slot.source.stop(now + 1.0);
      } catch {
        /* 已经停了 */
      }
      slot.source = null;
      slot.gain = null;
      slot.key = null;
    }
  }
  st.playingKey = null;
}

/**
 * 应用当前状态（阶段 / 风格 / 开关）→ 让实际播放内容与状态一致
 *
 * ⚠️ 为什么是"幂等的 apply"而不是"每次变化都直接播"：
 *   阶段、风格、开关三者任意一个变化都要反映到播放上，
 *   但它们可能**连续变化**（用户快速点风格切换），
 *   → 统一收敛到一个 apply，由它做"当前应该放什么"的判断，天然防抖。
 */
export async function applyScore(): Promise<void> {
  const st = getScoreState();
  const eng = getEngine();

  if (!eng.unlocked || !eng.ctx || !eng.scoreEnabled) {
    if (eng.ctx && !eng.scoreEnabled) stopScore();
    return;
  }

  const style = eng.style;
  const phase = eng.phase;
  const key = trackKey(style, phase);
  if (st.playingKey === key) return;

  await loadManifest();

  const buffer = await loadTrack(style, phase);
  if (!buffer) return;

  // ⚠️ await 期间状态可能又变了 → 复核，避免播错曲子
  if (trackKey(eng.style, eng.phase) !== key) {
    void applyScore();
    return;
  }
  /**
   * ⚠️⚠️ 还要复核「配乐层是否已被关掉」（2026-11-17 补）
   *
   * ⚠️ 为什么必须复核：
   *   上面两次 await 是 **fetch + decodeAudioData**，本地也要几百毫秒，
   *   远程更久。这期间用户完全可以点了面板里的「♪」把配乐关掉。
   *   → 不复核的话，曲子会在用户**明确关掉之后**突然响起来，
   *     而且会一直响（因为没人再调用 applyScore 去停它）。
   *
   * ⚠️ 为什么不能只在函数开头检查：
   *   开头的检查拦得住"本来就关着"，拦不住"加载途中被关掉"。
   */
  if (!eng.unlocked || !eng.scoreEnabled) {
    stopScore();
    return;
  }
  startCrossfade(buffer, key);
}

/**
 * ⚠️ 这里**故意没有**预取（prefetch）能力：
 *   阶段切换时旧曲会一直播到新曲解码完成（交叉淡化是在 buffer 就绪后才开始的）
 *   → 等待期是**无感的**，预取带来的收益远小于它多下的那一份流量。
 *   → 与其留一个"承诺了但没人用"的预取 API，不如不做。
 */
