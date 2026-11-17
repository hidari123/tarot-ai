/**
 * 空气层 —— 极低电平的房间底噪
 *
 * ⚠️ 为什么需要它：
 *   AI 配乐有**乐句间隙**（尤其 selection 段刻意留白）。
 *   纯留白 = 数字静音 = 手机外放时"断掉"的突兀感。
 *   一层 -42dB 左右的空气声能让"安静"听起来像**房间里的安静**，
 *   而不是"没放声音"。
 *
 * ⚠️ 为什么音量这么低：
 *   这层是**存在感**而不是**可听度** —— 用户说不出它在，
 *   但拿掉之后会觉得"空气被抽掉了"。
 *
 * ⚠️ 为什么用粉噪声而不是白噪声：
 *   白噪声的等能量分布集中在高频 → 听起来像"电流沙沙"（刺耳）
 *   粉噪声（每倍频程等功率）→ 听起来像"风 / 空气"
 *
 * ⚠️ 为什么手机外放也成立：
 *   空气层的高通在 140Hz → 手机扬声器放不出超低频
 *   → 剩下的中高频恰好是手机能还原的区间 → 效果不打折。
 */

import { getEngine } from "./engine";
import { MATERIALS } from "./materials";

interface AirState {
  /** 噪声源 */
  src: AudioBufferSourceNode | null;
  /** 空气层的增益 */
  gain: GainNode | null;
  /** 呼吸用的极低频调制器 */
  lfo: OscillatorNode | null;
  /** 材质的低通（换风格时改截止频率） */
  lp: BiquadFilterNode | null;
}

const AIR_KEY = "__mysticTarotAir";

function getAirState(): AirState {
  const g = globalThis as unknown as Record<string, AirState | undefined>;
  if (!g[AIR_KEY]) {
    g[AIR_KEY] = { src: null, gain: null, lfo: null, lp: null };
  }
  return g[AIR_KEY]!;
}

/**
 * 粉噪声缓冲（1 秒，循环用）
 *
 * ⚠️ 用 Paul Kellet 的经济型粉噪声滤波器：
 *   7 个一阶低通累加出 -3dB/oct 的近似 → 比白噪声柔和得多。
 */
function makePinkNoise(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return buf;
}

/** 启动空气层（幂等） */
export function startAir(): void {
  const st = getAirState();
  const eng = getEngine();
  const ctx = eng.ctx;
  const bus = eng.airBus;
  if (!ctx || !bus || st.src) return;

  const mat = MATERIALS[eng.style];

  const src = ctx.createBufferSource();
  src.buffer = makePinkNoise(ctx);
  src.loop = true;

  // 高通：切掉手机放不出的超低频（也避免和配乐的低频打架）
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 140;

  // 低通：材质决定"房间"是明亮还是幽深
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = mat.airHz;

  const gain = ctx.createGain();
  gain.gain.value = 0.008; // ≈ -42dB

  src.connect(hp);
  hp.connect(lp);
  lp.connect(gain);
  gain.connect(bus);
  src.start();

  // 极慢的呼吸（周期 ~25 秒）→ 空气层"活着"而不是死板的一层白噪声
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 0.04;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.003; // 幅度是基础音量的 37%
  lfo.connect(lfoDepth);
  lfoDepth.connect(gain.gain);
  lfo.start();

  st.src = src;
  st.gain = gain;
  st.lfo = lfo;
  st.lp = lp;
}

/**
 * 换风格时更新空气层的材质（"房间"的明暗）
 *
 * ⚠️ 为什么改截止频率而不是重建整层：
 *   重建会有一个瞬时的断点（空气声突然断一下）→ 在配乐切换的交叉淡化里很突兀。
 *   → 改参数是连续的。
 */
export function updateAirMaterial(): void {
  const st = getAirState();
  const eng = getEngine();
  if (!st.lp || !eng.ctx) return;
  const mat = MATERIALS[eng.style];
  st.lp.frequency.setTargetAtTime(mat.airHz, eng.ctx.currentTime, 0.6);
}

/** 停止空气层 */
export function stopAir(): void {
  const st = getAirState();
  const eng = getEngine();
  const now = eng.ctx?.currentTime ?? 0;
  if (st.gain && eng.ctx) {
    st.gain.gain.cancelScheduledValues(now);
    st.gain.gain.setValueAtTime(st.gain.gain.value, now);
    st.gain.gain.linearRampToValueAtTime(0, now + 0.8);
  }
  if (st.src) {
    try {
      st.src.stop(now + 1);
    } catch {
      /* 已经停了 */
    }
  }
  if (st.lfo) {
    try {
      st.lfo.stop(now + 1);
    } catch {
      /* 已经停了 */
    }
  }
  st.src = null;
  st.gain = null;
  st.lfo = null;
  st.lp = null;
}
