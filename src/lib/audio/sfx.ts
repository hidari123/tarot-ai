/**
 * 事件音效层 —— 标记仪式的节拍
 *
 * ⚠️ 核心原则：**单一材质**
 *   配乐是玻璃，那翻牌就是玻璃轻击；配乐是深水，那翻牌就是水面拍击。
 *   → 所有事件的频谱结构都落在同一族上 → 叠在配乐里不会"跳出来"。
 *
 * ⚠️ 为什么事件音必须**短**：
 *   配乐是持续层，事件音是打断层。
 *   事件音的尾巴若拖太长（>2s），会和配乐的下一个乐句叠在一起 → 变成"嗡"→ 刺耳。
 *   → 所有事件的衰减都控制在 0.5~3.2 秒，且**不做长混响尾巴**。
 *
 * ⚠️ 为什么"牌面揭示"要用**非谐波泛音**（1 : 1.5 : 2 : 3）：
 *   整数倍泛音 = 谐波 → 听起来像风琴/单簧管（"电子"）
 *   非整数倍（1.5）→ 泛音落在谐波之间 → 金属/玻璃质感 → 像颂钵
 *   → 这是"揭示"这一下能成为全应用音色制高点的原因。
 */

import { getEngine } from "./engine";
import { MATERIALS, type SfxKind } from "./materials";

/**
 * 播放一次性事件音效
 *
 * ⚠️ 必须在**用户手势之后**才有意义（浏览器自动播放策略）→ 未解锁时直接返回。
 */
export function playSfx(kind: SfxKind): void {
  const eng = getEngine();
  if (!eng.unlocked || eng.muted) return;
  const ctx = eng.ctx;
  const bus = eng.sfxBus;
  if (!ctx || !bus) return;

  const mat = MATERIALS[eng.style];
  const now = ctx.currentTime;

  /* ---- 工具：创建一条带包络的振荡器 ---- */
  const tone = (
    freq: number,
    gainValue: number,
    decay: number,
    when: number,
    type: OscillatorType = "sine",
    detune = 0
  ): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    osc.detune.value = detune;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainValue), when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    osc.connect(g);
    g.connect(bus);
    osc.start(when);
    osc.stop(when + decay + 0.05);
  };

  /* ---- 工具：噪声脉冲（带通扫描）---- */
  const noiseHit = (
    centerHz: number,
    sweepToHz: number,
    dur: number,
    gainValue: number,
    when: number,
    q = 1.1
  ): void => {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(centerHz, when);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, sweepToHz), when + dur);
    bp.Q.value = q;

    const g = ctx.createGain();
    g.gain.setValueAtTime(gainValue, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    src.connect(bp);
    bp.connect(g);
    g.connect(bus);
    src.start(when);
    src.stop(when + dur + 0.02);
  };

  switch (kind) {
    /* ══════════ 翻牌 ══════════
     * 用户亲手把卡背翻过来 —— 是"动作"，不是"事件"
     * → 要的是接触感（摩擦 + 轻微叩击），不是响声 */
    case "flip": {
      // ① 表面摩擦：材质的"表面"决定摩擦的频段
      noiseHit(mat.flipNoiseHz, mat.flipNoiseHz * 0.55, 0.055, 0.035, now, 1.2);
      // ② 轻微叩击：手指碰到卡牌的瞬间
      const thump = ctx.createOscillator();
      thump.type = "sine";
      thump.frequency.setValueAtTime(mat.flipThumpHz, now);
      thump.frequency.exponentialRampToValueAtTime(mat.flipThumpHz * 0.6, now + 0.12);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.055, now);
      tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      thump.connect(tg);
      tg.connect(bus);
      thump.start(now);
      thump.stop(now + 0.22);
      // ③ 材质的余韵（玻璃有，水没有 → 材质差异从这里体现出来）
      if (mat.flipPingHz > 0) {
        tone(mat.flipPingHz, 0.022, 0.55, now + 0.01);
      }
      break;
    }

    /* ══════════ 牌面揭示 ══════════
     * 全应用最重要的一下 —— 占卜师的第一句解读伴随它出现
     * → 必须是最亮、最有存在感、同时最不刺耳的音 */
    case "reveal": {
      const partialGains = [1, 0.5, 0.26, 0.12];
      mat.revealPartials.forEach((mult, i) => {
        tone(
          mat.revealBase * mult,
          0.075 * partialGains[i],
          mat.revealDecay * (1 - i * 0.12),
          now + i * 0.006,
          "sine",
          i === 0 ? 0 : (i % 2 === 0 ? 4 : -4)  // 轻微失谐 → 宽度
        );
      });
      // 一层极轻的高频"闪"——像光洒在牌面上
      tone(mat.revealBase * 4, 0.012, 0.9, now + 0.01);
      break;
    }

    /* ══════════ 选中一张牌 ══════════
     * 确认动作 → 轻快的上行双音 */
    case "select": {
      tone(mat.revealBase, 0.05, 0.5, now);
      tone(mat.revealBase * 1.5, 0.035, 0.6, now + 0.07);
      break;
    }

    /* ══════════ 回答占卜师的问题 ══════════
     * "占卜师听见了你" → 柔和的下行确认音 */
    case "answer": {
      tone(mat.revealBase * 0.75, 0.05, 0.55, now);
      tone(mat.revealBase * 1.125, 0.03, 0.75, now + 0.06);
      break;
    }

    /* ══════════ 仪式/阶段开始 ══════════
     * 清亮的一记 → 向上 */
    case "chime": {
      tone(mat.revealBase * 2, 0.04, 0.9, now);
      tone(mat.revealBase * 3, 0.022, 1.1, now + 0.05);
      break;
    }

    /* ══════════ 阶段转换 ══════════
     * 低沉、有重量 —— 标记"进入新的一段" */
    case "gong": {
      const partials = [1, 1.5, 2.0];
      const detunes = [-8, 6, -4];
      partials.forEach((mult, i) => {
        tone(
          mat.gongBase * mult,
          0.055 * (1 - i * 0.25),
          mat.gongDecay * (1 - i * 0.2),
          now + i * 0.01,
          "sine",
          detunes[i]
        );
      });
      break;
    }
  }
}
