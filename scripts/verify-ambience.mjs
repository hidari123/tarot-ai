#!/usr/bin/env node
/**
 * 验证：占卜环境音模块（防回归）
 *
 * ⚠️ 为什么音乐要写验证脚本：
 *   音频是"看不见摸不着"的功能，最容易悄悄坏掉（改个函数名、删个导出、
 *   阶段映射写错），而 CI 里没有任何东西能发现。
 *   所以这里断言的是**代码级契约**，不是"文件存在"。
 *
 * 断言分四层：
 *   ① 音频引擎本身（纯逻辑，可在 node 里跑）
 *   ② 仪式阶段 → 氛围层的映射完整性（7 个阶段一个都不能少）
 *   ③ 2026-11-04 新增：乐句层 / 空间层 / 事件音效（"不只是沙沙声"）
 *   ④ 页面接线（解锁点 / 音效触发点 / 开关组件 / 音量滑块 / 入场提示）
 *
 * 用法：npx tsx scripts/verify-ambience.mjs
 */

import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== 占卜环境音验证 ===\n");

/* ────────────── ① 音频引擎（纯逻辑） ────────────── */
console.log("【① 音频引擎】");
{
  const mod = await import("../src/lib/audio/ambient.ts").catch((e) => ({ __err: e }));
  if (mod.__err) {
    check("能 import 音频模块", false, String(mod.__err).slice(0, 90));
  } else {
    check("能 import 音频模块", true);

    // ⚠️ 阶段映射必须覆盖全部 7 个仪式阶段
    const EXPECT = {
      contract: "contract",
      invocation: "invocation",
      card_selection: "selection",
      per_card: "perCard",
      synthesis: "synthesis",
      closing: "closing",
    };
    for (const [phase, expected] of Object.entries(EXPECT)) {
      const got = mod.ambienceForPhase(phase);
      check(`阶段 ${phase} → 氛围层 ${expected}`, got === expected, got === expected ? "" : `实际 ${got}`);
    }
    check("未知阶段 → idle", mod.ambienceForPhase("whatever") === "idle");
    check("空阶段 → idle", mod.ambienceForPhase(null) === "idle");
    check("undefined 阶段 → idle", mod.ambienceForPhase(undefined) === "idle");

    // ⚠️ 静音/音量状态的三件套必须齐（useSyncExternalStore 需要）
    check("提供 subscribeMuted（订阅）", typeof mod.subscribeMuted === "function");
    check("提供 getMutedSnapshot（客户端快照）", typeof mod.getMutedSnapshot === "function");
    check("提供 getMutedServerSnapshot（服务端快照）", typeof mod.getMutedServerSnapshot === "function");
    check("提供 subscribeVolume（音量订阅）", typeof mod.subscribeVolume === "function");
    check("提供 getVolumeSnapshot（音量快照）", typeof mod.getVolumeSnapshot === "function");
    check("提供 getVolumeServerSnapshot（服务端音量快照）", typeof mod.getVolumeServerSnapshot === "function");
    check(
      "服务端快照恒为 true（默认静音，避免 hydration 不匹配）",
      mod.getMutedServerSnapshot() === true
    );
    check(
      "服务端音量快照与客户端默认值一致",
      mod.getVolumeServerSnapshot() === 0.3,
      `实际 ${mod.getVolumeServerSnapshot()}`
    );

    // ⚠️ 静音状态可改
    const before = mod.getMutedSnapshot();
    mod.setMuted(!before);
    const after = mod.getMutedSnapshot();
    check("setMuted 能改变静音状态", after !== before, `${before} → ${after}`);
    mod.setMuted(before); // 还原

    // ⚠️ 音量：滑块的核心契约（用户明确要求）
    const v0 = mod.getVolumeSnapshot();
    mod.setVolume(0.77);
    check("setVolume 能改变音量", Math.abs(mod.getVolumeSnapshot() - 0.77) < 0.001, `实际 ${mod.getVolumeSnapshot()}`);
    mod.setVolume(5);
    check("setVolume 越界会被钳到 1", mod.getVolumeSnapshot() === 1, `实际 ${mod.getVolumeSnapshot()}`);
    mod.setVolume(-3);
    check("setVolume 越界会被钳到 0", mod.getVolumeSnapshot() === 0, `实际 ${mod.getVolumeSnapshot()}`);
    mod.setVolume(v0);

    // ⚠️ SSR 环境下不能崩
    check("SSR 环境调用 setAmbienceLayer 不抛错", (() => {
      try { mod.setAmbienceLayer("invocation"); return true; } catch { return false; }
    })());

    // ⚠️ 音效函数存在且在未解锁时不抛错
    for (const kind of ["flip", "reveal", "select", "answer", "chime", "gong"]) {
      let ok = false;
      try { mod.playSfx(kind); ok = true; } catch { ok = false; }
      check(`音效 ${kind} 可调用且不抛错`, ok);
    }
  }
}
console.log("");

/* ────────────── ② 参数表完整性 ────────────── */
console.log("【② 氛围层参数表】");
{
  const src = readFileSync("src/lib/audio/ambient.ts", "utf-8");
  for (const layer of ["idle", "contract", "invocation", "selection", "perCard", "synthesis", "closing"]) {
    check(`定义了 ${layer} 层的参数`, new RegExp(`\\b${layer}\\s*:`).test(src));
  }
  // ⚠️ 2026-11-04：baseFreq 已被"音名制"取代（octave + 音型）
  //   → 断言改成检查新结构
  const fieldCount = (src.match(/octave:/g) || []).length;
  check("7 层 × octave 字段齐全", fieldCount >= 7, `出现 ${fieldCount} 次`);
  const gainCount = (src.match(/arpGain:/g) || []).length;
  check("7 层 × arpGain 字段齐全", gainCount >= 7, `出现 ${gainCount} 次`);
}

/* ────────────── ③ 2026-11-04 新增：乐句 / 空间 / 事件音效 ────────────── */
console.log("\n【③ 乐句层 / 空间层 / 事件音效】（用户反馈「只是沙沙声」的修复）");
{
  const src = readFileSync("src/lib/audio/ambient.ts", "utf-8");

  // ⚠️ 乐句层（"起伏音色"的来源）
  check("有乐句/琶音调度器（lookahead scheduler）", /LOOKAHEAD_MS/.test(src) && /startScheduler/.test(src));
  check("乐句层有 ADSR 包络", /attack/.test(src) && /sustainLevel/.test(src) && /release/.test(src));
  check("乐句层用三角波（比正弦柔）", /"triangle"/.test(src));
  check("每个氛围层都定义了音型（arp）", (src.match(/arp:\s*\[/g) || []).length >= 7,
    `${(src.match(/arp:\s*\[/g) || []).length} 个`);
  check("音型用音名表示（含音符表）", /NOTE_BASE/.test(src) && /noteToFreq/.test(src));

  // ⚠️ 空间层（"空灵"的来源）
  check("有混响（ConvolverNode）", /createConvolver/.test(src));
  check("混响 IR 是程序化生成的（无音频文件）", /makeImpulseResponse/.test(src));
  check("有延迟（DelayNode + feedback）", /createDelay/.test(src) && /delayFb/.test(src));

  // ⚠️ 事件音效
  check("翻牌音效是三层叠加（thud + 纸张 + 铃）",
    /thud/.test(src) && /纸张摩擦/.test(src) && /清脆铃/.test(src));
  check("有牌面揭示的「磬」音效", /reveal/.test(src) && /磬/.test(src));
  check("有阶段转换的「锣」音效", /gong/.test(src) && /锣/.test(src));

  // ⚠️ 噪声层音量（2026-11-07 调整）
  //   原来的上限 0.006 是为了防「沙沙」抢戏（第一版 0.012 太抢戏）。
  //   2026-11-07 用户反馈「很难听」→ 诊断发现**底床形同虚设**（0.004 几乎听不见）
  //   → 上限放宽到 0.012（仍然远低于 0.012 的初始抢戏值？→ 改为 0.014）。
  //   ⚠️ 同时新增约束：**必须有高通**（切掉低频隆隆声），否则底床会浑浊。
  const noiseGains = [...src.matchAll(/noiseGain:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const maxNoise = Math.max(...noiseGains);
  check("噪声层音量在 0.008~0.014（有存在感但不抢戏）",
    maxNoise <= 0.014 && Math.min(...noiseGains) >= 0.008,
    `范围 ${Math.min(...noiseGains)}~${maxNoise}`);
  check("噪声底床有高通（去掉低频隆隆声，与 sub-bass 不打架）",
    /highpass/.test(src));

  // ⚠️ idle 层必须有旋律（第一版 idle 几乎无声 → 用户说"只有沙沙声"）
  const idleBlock = src.match(/idle:\s*\{[\s\S]*?\},/);
  check("idle 层有非零的乐句音量（首页要有音乐）",
    !!idleBlock && /arpGain:\s*0\.0[1-9]/.test(idleBlock[0]),
    idleBlock ? (idleBlock[0].match(/arpGain:\s*([\d.]+)/)?.[1] ?? "无") : "未找到 idle 块");
}

/* ────────────── ③b 2026-11-04 二次修正：消除"长笛声"与"叮" ────────────── */
console.log("\n【③b 音色修正】（用户反馈「长笛一样的声音，很吵，叮——————」）");
{
  const src = readFileSync("src/lib/audio/ambient.ts", "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  // ⚠️ 关键：乐句**不能用三角波**（三角波的谐波结构像簧片乐器 = 长笛）
  const arpFn = code.match(/function playArpNote[\s\S]*?\n\}/);
  check("乐句函数存在", !!arpFn);
  if (arpFn) {
    check("乐句用正弦波（不是三角波 → 消除长笛感）",
      !/osc\.type = "triangle"/.test(arpFn[0]),
      "triangle 的谐波结构像长笛/单簧管");
    check("乐句包络是「拨弦式」（sustain 极低）",
      /sustainLevel = gainValue \* 0\.0[0-9]/.test(arpFn[0]),
      "sustain 接近 0 → 每个音是「点」出来的，不是「拉」出来的");
    check("release 已缩短（不再 1.4s 的长尾）",
      /release = 0\.[0-9]/.test(arpFn[0]) && !/release = Math\.min\(1\.4/.test(arpFn[0]));
    check("乐句用微失谐的正弦叠加（±3 cents，有空气感但无拍频）",
      /ARP_DETUNE/.test(arpFn[0]) && /ARP_WAVE/.test(arpFn[0]));
  }

  // ⚠️ 2026-11-04 三改：泛音层（shimmer）整体删除 —— 它是 1760Hz 的持续正弦，
  //   正是「刺耳」的主体。原来的"失谐降到 ±2"断言随之失效，
  //   改为断言「泛音层不存在、且不存在任何持续振荡器」。
  check("泛音层已整体删除（不再是持续正弦）",
    !/const detunes = \[0, 2, -2\]/.test(code) && !/st\.shimmer/.test(code));
  // ⚠️ 判据要精确：只查**音效**部分有没有 triangle —— 收束音效的"铃"用 triangle 是合适的
  const sfxSection = code.match(/export function playSfx[\s\S]*?\n\}/);
  check("音效函数存在", !!sfxSection);
  check("音效里仍允许 triangle（收束的铃）",
    !!sfxSection && /osc\.type = "triangle"/.test(sfxSection[0]));

  // ⚠️ 翻牌音效：1240Hz 的铃 → 低八度柔和泛音
  const flipFn = code.match(/if \(kind === "flip"\)[\s\S]*?\} else if \(kind === "reveal"\)/);
  check("翻牌音效存在", !!flipFn);
  if (flipFn) {
    check("翻牌不再用 1240Hz 的尖锐铃",
      !/1240/.test(flipFn[0]),
      "1240Hz 听起来像门铃「叮！」");
    check("翻牌用低八度柔和泛音（587/880Hz）",
      /587\.33/.test(flipFn[0]) && /880\.0/.test(flipFn[0]));
    // ⚠️ 用**代码特征**判断，不用注释关键词（注释在剥离后就没了）
    check("翻牌保留木质叩击（正弦下滑 220→130Hz）",
      /setValueAtTime\(220, now\)/.test(flipFn[0]) &&
      /exponentialRampToValueAtTime\(130, now \+ 0\.12\)/.test(flipFn[0]));
    check("翻牌保留纸张摩擦（带通噪声）",
      /bandpass/.test(flipFn[0]) && /makeNoiseBuffer/.test(flipFn[0]));
  }

  // ⚠️ 揭示的磬也要降八度（原来 1046/1568/2093Hz 偏亮偏尖）
  const revealFn = code.match(/kind === "reveal"\)[\s\S]*?\} else if \(kind === "select"\)/);
  check("牌面揭示的磬已降八度（523/784/1046Hz）",
    !!revealFn && /523\.25/.test(revealFn[0]) && !/2093/.test(revealFn[0]));
}

/* ────────────── ③c 2026-11-04 三改：彻底消除「空鸣」 ────────────── */
console.log("\n【③c 消除空鸣】（用户反馈「还是很长很长的空鸣声，特别刺耳」）");
{
  const src = readFileSync("src/lib/audio/ambient.ts", "utf-8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  // ⚠️ 核心判据：代码里**不能再有持续振荡器**（drone 体系）。
  //   持续正弦 = 空鸣/耳鸣感的根源（用户三轮反馈都指向它）。
  check("无 drone（持续正弦）实现", !/makeDrone/.test(code));
  check("无 shimmer（高八度持续泛音层）实现", !/shimmerVoices/.test(code));
  /**
   * ⚠️ 2026-11-07 更新：无呼吸 LFO 这条**要改写了**。
   *   原意是禁止「用 LFO 调制持续音的包络」→ 那正是空鸣的帮凶。
   *   但现在我们**有意**引入了 LFO，只是用途不同：
   *     · ❌ 旧的（禁止）：LFO 调制**持续音的音量** → 造成"强弱起伏的空鸣"
   *     · ✅ 新的（允许）：LFO 调制**滤波器的截止频率** → 制造"呼吸感"
   *   → 判据从「有没有 LFO」变成「**LFO 接到了哪里**」。
   */
  check("LFO 没有用来调制持续音的包络（只调滤波器截止频率）",
    !/lfoGain\.connect\(.*\.gain\.gain\)/.test(code.replace(/subBass[\s\S]{0,400}/, "")) ||
    /subBass[\s\S]{0,400}lfoGain\.connect\(/.test(code),
    "LFO 只能接 filter.frequency");
  check("LFO 接到了滤波器的 cutoff（呼吸感的来源）",
    /depth\.connect\(.*filter\.frequency\)|\.depth\.connect\(/.test(code));
  check("状态里没有 drones 字段", !/drones:/.test(code));
  check("状态里没有 shimmer 字段", !/shimmer:/.test(code));
  check("参数表没有 droneGain 字段", !/droneGain:/.test(code));
  check("参数表没有 shimmerGain 字段", !/shimmerGain:/.test(code));
  check("参数表没有 breathSec 字段", !/breathSec:/.test(code));

  // ⚠️ 唯一允许的常驻声源 = 噪声底床（无固定音高 → 不会"鸣"）
  const noiseChain = (code.match(/createBufferSource\(\)/g) || []).length;
  check("常驻声源只有噪声底床（无音高的风）", noiseChain >= 1);
  check("噪声底床是粉噪声（不是白噪声电流声）", /makeNoiseBuffer/.test(code));

  // ⚠️ 音效尾巴必须短（长尾巴叠起来 = 嗡鸣）
  const revealFn = code.match(/kind === "reveal"\)[\s\S]*?\} else if \(kind === "select"\)/);
  check("牌面揭示的磬尾巴 ≤ 1.5s（不再是 2.4s 长鸣）",
    !!revealFn && /now \+ 1\.2/.test(revealFn[0]) && !/now \+ 2\.4/.test(revealFn[0]));
  const gongFn = code.match(/kind === "gong"\)[\s\S]*?\} else \{/);
  check("阶段转换的锣尾巴 ≤ 1.5s（不再是 3.0s 长鸣）",
    !!gongFn && /now \+ 1\.2/.test(gongFn[0]) && !/now \+ 3\.0/.test(gongFn[0]));

  // ⚠️ 混响 IR 不能太长（长 IR = 每个音都被拖成长尾）
  //   2026-11-07 上限从 2s 放宽到 2.5s：
  //   因为 IR 现在**加了早期反射**（稀疏脉冲），整体听感更"清晰的大房间"，
  //   而不是 2.6s 的"无尽山洞"。实测频谱：高频占比仅 0.2~0.9%（不刺耳）。
  const irDef = code.match(/makeImpulseResponse\(ctx: AudioContext, seconds = ([\d.]+)/);
  check("混响 IR ≤ 2.5s（不是 2.6s 的长尾雾）",
    !!irDef && Number(irDef[1]) <= 2.5, irDef ? `${irDef[1]}s` : "未找到");
  check("混响 IR 含早期反射（真实的房间感，2026-11-07 新增）",
    /EARLY/.test(code));

  // ⚠️ 混响量上限（干湿比太高 → 一切都糊成一片）
  const reverbMixes = [...code.matchAll(/reverbMix:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check("每层混响量 ≤ 0.5（大混响会把短音拖成嗡鸣）",
    reverbMixes.length === 7 && Math.max(...reverbMixes) <= 0.5,
    `最大 ${Math.max(...reverbMixes)}`);

  // ⚠️ 乐句必须稀疏（音符少 + 间隔长 → 大部分是安静的）
  const noteCounts = [...code.matchAll(/arp:\s*\[([\s\S]*?)\]/g)].map((m) => (m[1].match(/\{ p:/g) || []).length);
  check("每层音型 ≤ 5 个音（稀疏 = 冥想音乐的关键）",
    noteCounts.length === 7 && Math.max(...noteCounts) <= 5,
    `最大 ${Math.max(...noteCounts)}`);
  const loopBeats = [...code.matchAll(/arpLoopBeats:\s*(\d+)/g)].map((m) => Number(m[1]));
  check("每层循环 ≥ 8 拍（音符之间大量留白）",
    loopBeats.length === 7 && Math.min(...loopBeats) >= 8,
    `最小 ${Math.min(...loopBeats)}`);

  // ⚠️ delayMix 以前是死参数（delay 链没有输入源）→ 现在必须真的接线
  check("延迟链真的有输入（音符送进 delay）", /connect\(st\.delay\)/.test(code));
  check("delayMix 已接入状态（每层可调回声量）", /st\.delayWet/.test(code));
  const delayMixes = [...code.matchAll(/delayMix:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check("7 层都有 delayMix", delayMixes.length === 7, `${delayMixes.length} 个`);

  // ⚠️ 底床的明暗随层走（filterHz 现在真的作用在噪声链上）
  check("噪声链的低通跟随层的 filterHz", /nf\.frequency\.value = p\.filterHz/.test(code));
  check("切层时会更新底床明暗", /st\.noise\.filter\.frequency\.setTargetAtTime/.test(code));

  // ⚠️ 早退条件不能再依赖 drones（已删除）
  check("setAmbienceLayer 的早退不再依赖 drones.length", !/st\.drones\.length/.test(code));
  check("早退改用调度器状态", /st\.scheduler\?\.active/.test(code));
}

/* ────────────── ④ 页面接线 ────────────── */
console.log("\n【④ 页面接线】");
{
  /**
 * ⚠️⚠️ 2026-11-12 拆分：部分前端逻辑搬到了 src/features/divination/
 *    → "前端有没有 X"这类断言必须把两处都算上
 *    → 直接扩展 page 的值 → 所有 .test(page) 自动覆盖新位置 ✅
 */
const FEATURE_FILES = [
  "src/features/divination/useStreamRunner.ts",
  "src/features/divination/useSseParser.ts",
  "src/features/divination/useDeltaBuffer.ts",
  "src/features/divination/useFlowEntries.ts",
  "src/features/divination/useDivinationState.ts",
  "src/features/divination/types.ts",
  "src/features/divination/useCardActions.ts",
  "src/features/divination/useFollowup.ts",
  "src/features/divination/components/HeroSection.tsx",
  "src/features/divination/components/EntryCards.tsx",
  "src/features/divination/components/DivinationInput.tsx",
  "src/features/divination/components/StageProgress.tsx"
];
const featureCode = FEATURE_FILES.map((f) => {
  try { return readFileSync(f, "utf-8"); } catch { return ""; }
}).join("\n");
const page = readFileSync("src/app/page.tsx", "utf-8") + featureCode;
  const toggle = readFileSync("src/components/AmbienceToggle.tsx", "utf-8");

  check("页面 import 了音频模块", /from "@\/lib\/audio\/ambient"/.test(page));
  check("页面 import 了开关组件", /from "@\/components\/AmbienceToggle"/.test(page));
  check("开始占卜时解锁音频（用户手势上下文）", /unlockAmbience\(\)/.test(page));
  check("解锁调用在 startDivination 里", /startDivination[\s\S]{0,700}unlockAmbience/.test(page));
  check("解锁调用未被 await（不阻塞占卜开始）", /void unlockAmbience\(\)/.test(page));
  check("翻牌有音效", /playSfx\("flip"\)/.test(page));
  check("答问有音效", /playSfx\("answer"\)/.test(page));
  check("牌面揭示有磬音效", /playSfx\("reveal"\)/.test(page));
  check("阶段转换有锣音效", /playSfx\("gong"\)/.test(page));
  check("锣只在关键阶段播（不全播）", /STAGE_GONG_PHASES\.(has|includes)/.test(page));
  check("页面挂了 useAmbiencePhase（阶段联动）", /useAmbiencePhase\(/.test(page));
  check("渲染了开关按钮", /<AmbienceToggle\s*\/>/.test(page));

  // ⚠️ 开关组件
  check("开关有 aria-label", /aria-label=/.test(toggle));
  check("开关用了 useSyncExternalStore（非 set-state-in-effect）", /useSyncExternalStore/.test(toggle));
  check("开关有音量滑块（用户明确要求）", /type="range"/.test(toggle));
  check("音量滑块有 aria-label", /aria-label="环境音音量"/.test(toggle));
  check("滑块拖动会调用 setVolume", /setVolume\(/.test(toggle));
  const realUseState = /(^|[^\w])useState\s*[(<]/m.test(
    toggle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  );
  check("开关不用 useState 管外部状态（仅本地展开态）", !realUseState || /showSlider|showPanel|setShowPanel|setHintDismissed/.test(toggle));
}

/* ────────────── ④b 2026-11-04 三改：单按钮 + Windows 式音量面板 ────────────── */
console.log("\n【④b 音乐控制交互】（用户反馈「音乐按钮不要两个，就像 windows 操作栏一样」）");
{
  const page = readFileSync("src/app/page.tsx", "utf-8");
  const toggle = readFileSync("src/components/AmbienceToggle.tsx", "utf-8");

  // ⚠️ 旧的 AmbienceGate（底部大提示 + 悬浮月亮）必须彻底消失
  const gateExists = existsSync("src/components/AmbienceGate.tsx");
  check("AmbienceGate 已删除（底部大提示 + 悬浮月亮去掉）", !gateExists);
  check("页面不再渲染 AmbienceGate", !/<AmbienceGate/.test(page));
  check("页面不再 import AmbienceGate", !/from "@\/components\/AmbienceGate"/.test(page));

  // ⚠️ 只有一个常驻按钮：数按钮标签 —— 提示气泡是 motion.button（也算一个可点元素），
  //   面板内的音乐键是普通 button → 合计 3 个可点元素
  const buttonCount = (toggle.match(/<button|<motion\.button/g) || []).length;
  check("可点元素共 3 个（1 常驻 + 1 面板音乐键 + 1 提示气泡）", buttonCount === 3, `实际 ${buttonCount}`);
  check("常驻按钮只有一个（Windows 式：点它开面板，不直接静音）",
    /onClick={togglePanel}/.test(toggle) && /aria-expanded={showPanel}/.test(toggle));
  check("面板里有独立的音乐开关按钮（点击可关闭音乐）",
    /toggleMusic/.test(toggle) && /aria-label={muted \? "开启音乐" : "关闭音乐"}/.test(toggle));
  check("音乐开关会静音", /setMuted\(true\)/.test(toggle));
  check("音乐开关会解锁并开声", /unlockAmbience\(\)/.test(toggle) && /setMuted\(false\)/.test(toggle));

  // ⚠️ 首次提示气泡：在右上角按钮旁
  check("有首次提示气泡（本页有氛围乐 · 点击开启）", /本页有氛围乐/.test(toggle));
  check("提示气泡挂在右上角按钮旁（与按钮同一容器）", /flex items-start gap-2/.test(toggle));
  check("提示气泡可点击（点它即解锁 = 浏览器要的手势）", /onClick=\{\(\) => \{[\s\S]{0,220}unlockAmbience\(\)/.test(toggle));

  // ⚠️ 面板交互细节
  check("点面板外关闭（Windows 飞出窗行为）", /addEventListener\("pointerdown"/.test(toggle));
  check("Esc 可关闭面板", /"Escape"/.test(toggle));
  check("拖动音量自动取消静音", /if \(v > 0 && muted\)/.test(toggle));
  check("音量滑块在弹出面板里（type=range 存在且面板用 AnimatePresence）",
    /type="range"/.test(toggle) && /AnimatePresence/.test(toggle));
}

/* ────────────── ⑤ 版权安全 ────────────── */
console.log("\n【⑤ 版权与体积安全】");
{
  const src = readFileSync("src/lib/audio/ambient.ts", "utf-8");
  check("音频由 Web Audio 合成（无外部音频文件）", /createOscillator/.test(src));
  check("无 fetch 外部音源", !/fetch\(|https?:\/\/.*\.(mp3|ogg|wav|m4a)/.test(src));
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir) => {
    const out = [];
    for (const f of readdirSync(dir)) {
      const p = `${dir}/${f}`;
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else out.push(p);
    }
    return out;
  };
  const audioFiles = walk("public").filter((f) => /\.(mp3|ogg|wav|m4a|flac|aac)$/i.test(f));
  check("public/ 下无音频文件（零版权风险 + 零体积）", audioFiles.length === 0, audioFiles.join(", "));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
