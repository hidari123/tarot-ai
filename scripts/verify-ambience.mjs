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

import { readFileSync } from "node:fs";

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

  // ⚠️ 噪声层必须被压低（第一版 0.012 太抢戏）
  const noiseGains = [...src.matchAll(/noiseGain:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const maxNoise = Math.max(...noiseGains);
  check("噪声层音量已压低（≤0.006，防「沙沙」抢戏）", maxNoise <= 0.006, `最大 ${maxNoise}`);

  // ⚠️ idle 层必须有旋律（第一版 idle 几乎无声 → 用户说"只有沙沙声"）
  const idleBlock = src.match(/idle:\s*\{[\s\S]*?\},/);
  check("idle 层有非零的乐句音量（首页要有音乐）",
    !!idleBlock && /arpGain:\s*0\.0[1-9]/.test(idleBlock[0]),
    idleBlock ? (idleBlock[0].match(/arpGain:\s*([\d.]+)/)?.[1] ?? "无") : "未找到 idle 块");
}

/* ────────────── ④ 页面接线 ────────────── */
console.log("\n【④ 页面接线】");
{
  const page = readFileSync("src/app/page.tsx", "utf-8");
  const toggle = readFileSync("src/components/AmbienceToggle.tsx", "utf-8");
  const gate = readFileSync("src/components/AmbienceGate.tsx", "utf-8");

  check("页面 import 了音频模块", /from "@\/lib\/audio\/ambient"/.test(page));
  check("页面 import 了开关组件", /from "@\/components\/AmbienceToggle"/.test(page));
  check("页面 import 了入场组件", /from "@\/components\/AmbienceGate"/.test(page));
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
  check("渲染了入场提示（仅待机页）", /stage === "input" && <AmbienceGate/.test(page));

  // ⚠️ 开关组件
  check("开关有 aria-label", /aria-label=/.test(toggle));
  check("开关用了 useSyncExternalStore（非 set-state-in-effect）", /useSyncExternalStore/.test(toggle));
  check("开关有音量滑块（用户明确要求）", /type="range"/.test(toggle));
  check("音量滑块有 aria-label", /aria-label="环境音音量"/.test(toggle));
  check("滑块拖动会调用 setVolume", /setVolume\(/.test(toggle));
  const realUseState = /(^|[^\w])useState\s*[(<]/m.test(
    toggle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  );
  check("开关不用 useState 管外部状态（仅本地展开态）", !realUseState || /showSlider/.test(toggle));

  // ⚠️ 入场组件
  check("入场提示监听 window 的指针事件（任意处可点）", /addEventListener\("pointerdown"/.test(gate));
  check("入场提示用 capture 阶段（先于其他逻辑）", /capture: true/.test(gate));
  check("入场提示有 pointer-events-none（不挡交互）", /pointer-events-none/.test(gate));
  check("入场提示调用 unlockAmbience", /unlockAmbience\(\)/.test(gate));
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
