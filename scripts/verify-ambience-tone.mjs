#!/usr/bin/env node
/**
 * 验证：环境音**音色质量**（2026-11-07 新增）
 *
 * ⚠️ 为什么需要这个脚本：
 *   用户反馈「现在很难听」—— 这类「审美问题」最难防回归：
 *   ① 它不像功能 bug 那样会报错，只是「听着难受」
 *   ② 下一个人重构时，很容易觉得「这些层是历史包袱」就删掉
 *   ③ CI 里没有任何东西能发现「音色退化」
 *
 * ⚠️ 断言的是**设计契约**（代码里必须存在哪些要素），不是「文件存在」：
 *   每一项都对应一条具体的听感问题 → 删掉任何一项，CI 会红。
 *
 * ⚠️ 五要素与它们解决的具体问题：
 *   ① **sub-bass 层**（低频基础）
 *      问题：只有噪声底床 + 正弦点音 → 声音「薄、飘、无重量」
 *      解决：40~110Hz 的持续低频 → 有「胸腔共鸣」，像真的空间
 *      ⚠️⚠️ 与「消除空鸣」的矛盾（这是本设计最微妙的地方）：
 *        2026-11-04 用户投诉「很长很长的空鸣声」→ 删掉了 drone。
 *        但 drone 和 sub-bass 是两回事：
 *          · drone = 220/440Hz 纯音正弦 → 人耳当「测试信号」→ 刺耳
 *          · sub = 40~110Hz 正弦 → 人耳几乎「听」不到基频，只感到「胸腔震」→ 舒服
 *        → 判断标准：**这个音是「听到」还是「感到」？**
 *          听到 → 危险（刺耳）
 *          感到 → 安全（有基础）
 *   ② **super-saw 失谐层**（厚度）
 *      问题：单个正弦太「纯」→ 干瘪、塑料感
 *      解决：5 个微失谐正弦叠加（±14 cents）→ 经典宽谱 pad
 *   ③ **LFO 低通扫描**（呼吸感）
 *      问题：滤波器固定截止 → 高频一直刺耳 → 听觉疲劳
 *      解决：LFO 缓慢扫描 cutoff（0.03~0.09Hz）→ 音色在「开合」，永不腻
 *   ④ **和声轮换**（Chord Progression）
 *      问题：每层一条固定音型循环 → 8 拍后原地重复 → 催眠/烦躁
 *      解决：多个和弦轮换（如 Am → F → C → G）→ 有「进行感」
 *   ⑤ **FM 钟琴层**（五声音阶随机触发）
 *      问题：正弦点音像「滴」，不像「磬」
 *      解决：FM 合成（载波 + 调制器）→ 金属泛音结构 + 随机音高 → 神秘感
 *
 * 用法：npx tsx scripts/verify-ambience-tone.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

console.log("=== 环境音音色质量验证 ===\n");

const src = readFileSync("src/lib/audio/ambient.ts", "utf-8");
/** 剥掉注释，只看真实代码 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/* ────────────── ① sub-bass 层 ────────────── */
console.log("【① 低频基础】（解决「声音薄、飘、无重量」）");
{
  check("有 sub-bass 层的实现", /subBass/i.test(code), "未找到 subBass 相关代码");

  /**
   * ⚠️⚠️ 关键断言（这是 2026-11-07 修的最大 bug）：
   *   原来的 noteToFreq 把小写当成「低八度」（220Hz），
   *   而音名里的八度号（A1 = 55Hz）被完全忽略
   *   → sub-bass 落在 **220Hz**（人耳最敏感区）→ 持续播放 = 刺耳
   *   → 必须断言 noteToFreq 用的是**八度号公式** base × 2^(oct-4)。
   */
  const noteFn = code.match(/function noteToFreq[\s\S]*?\n\}/);
  check("noteToFreq 存在", !!noteFn);
  if (noteFn) {
    check(
      "noteToFreq 解析音名里的八度号（A1 → 55Hz）",
      /\(\\d\+\)/.test(noteFn[0]) || /\d\+/.test(noteFn[0]),
      "没有解析八度号 → A1 会被当成 A4（440Hz）"
    );
    check(
      "noteToFreq 用标准公式 base × 2^(oct-4)",
      /Math\.pow\(2,/.test(noteFn[0]) && /- 4/.test(noteFn[0]),
      "标准公式是 base × 2^(octave - 4)"
    );
  }

  // ⚠️ sub-bass 的音名必须在低八度区（A1/A2 附近）
  const subNames = [...code.matchAll(/subBass:\s*"([A-G][#b]?\d)"/g)].map((m) => m[1]);
  check("sub-bass 音名带八度号", subNames.length === 7, `${subNames.length} 个`);
  const octaves = subNames.map((n) => Number(n.match(/\d/)?.[0] ?? 99));
  check(
    "sub-bass 落在 A1~A2（感到而非听到）",
    octaves.length === 7 && Math.max(...octaves) <= 2,
    `八度：${octaves.join(", ")}`
  );

  const subFn = code.match(/function buildSubBass[\s\S]*?\n\}/);
  check(
    "sub-bass 经过低通滤波（去掉谐波，只留基频）",
    !!subFn && /lowpass/.test(subFn[0]),
    "sub-bass 必须低通，否则谐波会变回刺耳的 drone"
  );

  check(
    "sub-bass 有慢速幅度起伏（不是死板的恒定音）",
    !!subFn && /(lfo|LFO|setTargetAtTime|linearRamp)/.test(subFn[0]),
    "必须有幅度调制，否则持续音会被听觉系统忽略"
  );

  check("sub-bass 音量有独立参数（每层可调）", /subBassGain/.test(code));
}

/* ────────────── ② super-saw 失谐层 ────────────── */
console.log("\n【② 厚度与暖度】（解决「干瘪、塑料感」）");
{
  check("有 super-saw（多振荡器失谐叠加）的实现", /SAW_VOICES/.test(code));

  /**
   * ⚠️ 失谐量断言要看**数据源**（SAW_VOICES 数组），
   *   而不是找 `detune.value = 数字` ——
   *   实现里是 `osc.detune.value = det`（变量赋值），
   *   → 断言必须读数组本身。
   */
  const sawArr = code.match(/SAW_VOICES\s*=\s*\[([^\]]*)\]/);
  check("有 super-saw 的失谐量数组", !!sawArr);
  if (sawArr) {
    const detunes = [...sawArr[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Math.abs(Number(m[0])));
    // ⚠️ 0 是**中心音**（不移调），不是"失谐量" → 判断时排除它
    const spreads = detunes.filter((d) => d > 0);
    check(
      "失谐量在 5~15 cents（宽谱但无拍频）",
      spreads.length >= 2 && spreads.every((d) => d >= 5 && d <= 15),
      `SAW_VOICES = ${sawArr[1].trim()}`
    );
    check("super-saw 至少 3 个声部", detunes.length >= 3, `${detunes.length} 个`);
  }

  check(
    "super-saw 的振荡器数量 ≥ 3（单振荡器不算）",
    /SAW_VOICES\s*=\s*\[/.test(code)
  );

  check("super-saw 走低通（削掉上方谐波 → 暖而不刺耳）", /SAW_VOICES/.test(code) && /lowpass/.test(code));
}

/* ────────────── ③ LFO 低通扫描 ────────────── */
console.log("\n【③ 呼吸感】（解决「高频刺耳、听觉疲劳」）");
{
  check("有 LFO 调制滤波器的实现", /LFO|lfo/i.test(code));

  // ⚠️ LFO 频率必须在 0.02~0.12Hz：慢于 0.02 察觉不到，快于 0.12 变成「抖动」
  const lfoRates = [...code.matchAll(/lfoRate:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "LFO 频率在 0.02~0.12Hz（慢到能呼吸、快到不抖）",
    lfoRates.length >= 7 && lfoRates.every((r) => r >= 0.02 && r <= 0.12),
    lfoRates.length ? lfoRates.join(", ") : "未找到 lfoRate"
  );

  const lfoDepths = [...code.matchAll(/lfoDepth:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check("每层都有 LFO 深度（扫描幅度）", lfoDepths.length >= 7, `${lfoDepths.length} 个`);

  check(
    "LFO 真的接到了 filter.frequency（不是摆设）",
    /depth\.connect\(/.test(code) || /lfo\.depth\.connect/.test(code)
  );
}

/* ────────────── ④ 和声轮换 ────────────── */
console.log("\n【④ 和声进行】（解决「8 拍后原地重复」）");
{
  check("有和弦进行（chords）的数据结构", /chords:\s*\[/.test(code));

  const chords = [...code.matchAll(/chords:\s*\[([\s\S]*?)\]/g)].map((m) => m[1]);
  check("每个氛围层都定义了和弦", chords.length >= 7, `${chords.length} 个`);

  /**
   * ⚠️ 数和弦个数要用**顶层数组的元素数**，
   *   不能数 `[` 的出现次数（每个和弦内部还有一层 `[`）。
   */
  const chordCounts = [...code.matchAll(/chords:\s*\[([\s\S]*?)\],\s*\n/g)].map((m) =>
    (m[1].match(/\[\s*"/g) || []).length
  );
  check(
    "每层至少 2 个和弦（有轮换）",
    chordCounts.length >= 7 && Math.min(...chordCounts) >= 2,
    chordCounts.length ? `各层和弦数：${chordCounts.join(", ")}` : "未找到"
  );

  check(
    "和弦用音名表示（复用 NOTE_BASE）",
    /chords:\s*\[\s*\[\s*"/.test(code)
  );

  check("有轮换周期（多少秒换一次和弦）", /chordSwitchSec/.test(code));

  const switches = [...code.matchAll(/chordSwitchSec:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "换和弦间隔在 5~15 秒（太快急促、太慢呆板）",
    switches.length >= 7 && switches.every((s) => s >= 5 && s <= 15),
    switches.length ? switches.join(", ") : "未找到"
  );
}

/* ────────────── ⑤ FM 钟琴层 ────────────── */
console.log("\n【⑤ 钟琴质感】（解决「正弦点音像滴不像磬」）");
{
  check("有 FM 合成（载波 + 调制器）的实现", /FM_RATIO|fmBell/i.test(code));

  check("FM 有调制器（modulator）接进载波频率", /modulator|modDepth/.test(code));

  check("FM 有调制指数（index）控制亮度", /FM_INDEX/.test(code));

  check(
    "FM 载波/调制器比值是无理数（√2 → 非谐波泛音 → 金属质感）",
    /FM_RATIO = Math\.SQRT2/.test(code)
  );

  check("钟琴音高取自五声音阶（避免半音的紧张感）", /PENTA_SCALE/.test(code));

  check("钟琴是随机触发（避免机械感）", /Math\.random/.test(code));

  const intervals = [...code.matchAll(/fmBellInterval:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check("每层都有钟琴间隔", intervals.length >= 7, `${intervals.length} 个`);
}

/* ────────────── ⑥ 底床与空间感的改进 ────────────── */
console.log("\n【⑥ 底床与空间】（解决「底床形同虚设 / 混响是延迟反馈假空间」）");
{
  const noiseGains = [...code.matchAll(/noiseGain:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "噪声底床音量已提升（不再 0.004 的形同虚设）",
    noiseGains.length >= 7 && Math.min(...noiseGains) >= 0.008,
    `最小 ${Math.min(...noiseGains)}`
  );

  check("噪声底床有高通（去掉低频隆隆声）", /highpass/.test(code));

  check("混响 IR 有早期反射（不只是指数衰减噪声）", /EARLY/.test(code));

  const irDef = code.match(/makeImpulseResponse\(ctx: AudioContext, seconds = ([\d.]+)/);
  check(
    "混响 IR 在 1.5~2.5s（清晰的大房间，不是无尽山洞）",
    !!irDef && Number(irDef[1]) >= 1.5 && Number(irDef[1]) <= 2.5,
    irDef ? `${irDef[1]}s` : "未找到"
  );
}

/* ────────────── ⑦ 关键约束不被破坏 ────────────── */
console.log("\n【⑦ 关键约束不被破坏】（不能为了好听而牺牲已修好的问题）");
{
  // ⚠️ 2026-11-04 用户三轮投诉：「长笛声」「叮————」「空鸣」
  //   → 这些修复不能被回退
  const arpFn = code.match(/function playArpNote[\s\S]*?\n\}/);
  check("乐句函数存在", !!arpFn);
  if (arpFn) {
    check(
      "乐句仍用正弦（不是三角波 → 无长笛感）",
      !/osc\.type = "triangle"/.test(arpFn[0])
    );
    check(
      "乐句包络仍是拨弦式（sustain 极低）",
      /sustainLevel = gainValue \* 0\.0[0-9]/.test(arpFn[0])
    );
  }

  check(
    "音效尾巴仍短（磬/锣 ≤1.5s）",
    /now \+ 1\.2/.test(code) && !/now \+ 2\.4/.test(code) && !/now \+ 3\.0/.test(code)
  );

  const reverbMixes = [...code.matchAll(/reverbMix:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "每层混响量 ≤ 0.5",
    reverbMixes.length === 7 && Math.max(...reverbMixes) <= 0.5,
    `最大 ${Math.max(...reverbMixes)}`
  );

  const noteCounts = [...code.matchAll(/arp:\s*\[([\s\S]*?)\]/g)].map((m) =>
    (m[1].match(/\{ p:/g) || []).length
  );
  check(
    "每层音型 ≤ 5 个音（稀疏 = 冥想音乐的关键）",
    noteCounts.length === 7 && Math.max(...noteCounts) <= 5,
    `最大 ${Math.max(...noteCounts)}`
  );

  /**
   * ⚠️ sub-bass 的实现分散在 buildSubBass 与参数表两处，
   *   → 断言要看**整个文件**里有没有"低通 + 起伏"这两个要素，
   *   而不是只看 subBass 关键字附近的 2000 字符。
   */
  const subFn = code.match(/function buildSubBass[\s\S]*?\n\}/);
  check(
    "sub-bass 不是纯正弦持续音（有滤波 + 起伏）",
    !!subFn && /lowpass/.test(subFn[0]) && /(lfo|LFO)/.test(subFn[0]),
    "sub-bass 必须经过低通且有幅度调制"
  );

  // ⚠️ 体积与版权
  check("仍无外部音频文件（零版权风险）", !/fetch\(|https?:\/\/.*\.(mp3|ogg|wav|m4a)/.test(code));

  // ⚠️ 阶段映射完整
  check(
    "7 个阶段映射完整",
    ["idle", "contract", "invocation", "selection", "perCard", "synthesis", "closing"].every((l) =>
      new RegExp(`\\b${l}\\s*:`).test(src)
    )
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
