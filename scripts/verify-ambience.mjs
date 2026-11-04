#!/usr/bin/env node
/**
 * 验证：占卜环境音模块（防回归）
 *
 * ⚠️ 为什么音乐要写验证脚本：
 *   音频是"看不见摸不着"的功能，最容易悄悄坏掉（改个函数名、删个导出、
 *   阶段映射写错），而 CI 里没有任何东西能发现。
 *   所以这里断言的是**代码级契约**，不是"文件存在"。
 *
 * 断言分三层：
 *   ① 音频引擎本身（纯逻辑，可在 node 里跑）
 *   ② 仪式阶段 → 氛围层的映射完整性（7 个阶段一个都不能少）
 *   ③ 页面接线（解锁点 / 音效触发点 / 开关组件）
 *
 * 用法：node scripts/verify-ambience.mjs
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

    // ⚠️ 静音状态的三件套必须齐（useSyncExternalStore 需要）
    check("提供 subscribeMuted（订阅）", typeof mod.subscribeMuted === "function");
    check("提供 getMutedSnapshot（客户端快照）", typeof mod.getMutedSnapshot === "function");
    check("提供 getMutedServerSnapshot（服务端快照）", typeof mod.getMutedServerSnapshot === "function");
    check(
      "服务端快照恒为 true（默认静音，避免 hydration 不匹配）",
      mod.getMutedServerSnapshot() === true
    );

    // ⚠️ 解锁后必须真的解锁
    const before = mod.getMutedSnapshot();
    mod.setMuted(!before);
    const after = mod.getMutedSnapshot();
    check("setMuted 能改变静音状态", after !== before, `${before} → ${after}`);
    mod.setMuted(before); // 还原

    // ⚠️ SSR 环境下不能崩（AudioContext 不存在）
    check("SSR 环境调用 setAmbienceLayer 不抛错", (() => {
      try { mod.setAmbienceLayer("invocation"); return true; } catch { return false; }
    })());

    // ⚠️ 音效函数存在且在未解锁时不抛错
    for (const kind of ["flip", "select", "answer", "chime"]) {
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
  // ⚠️ 每个参数组必须有全部 6 个字段（少一个就会 undefined → 音频异常）
  const fieldCount = (src.match(/baseFreq/g) || []).length;
  check("7 层 × baseFreq 字段齐全", fieldCount >= 7, `出现 ${fieldCount} 次`);
}

/* ────────────── ③ 页面接线 ────────────── */
console.log("\n【③ 页面接线】");
{
  const page = readFileSync("src/app/page.tsx", "utf-8");
  const toggle = readFileSync("src/components/AmbienceToggle.tsx", "utf-8");

  check("页面 import 了音频模块", /from "@\/lib\/audio\/ambient"/.test(page));
  check("页面 import 了开关组件", /from "@\/components\/AmbienceToggle"/.test(page));
  check(
    "开始占卜时解锁音频（用户手势上下文）",
    /unlockAmbience\(\)/.test(page),
    ""
  );
  check("解锁调用在 startDivination 里", /startDivination[\s\S]{0,600}unlockAmbience/.test(page));
  check("翻牌有音效", /playSfx\("flip"\)/.test(page));
  check("答问有音效", /playSfx\("answer"\)/.test(page));
  check("页面挂了 useAmbiencePhase（阶段联动）", /useAmbiencePhase\(/.test(page));
  check("渲染了开关按钮", /<AmbienceToggle\s*\/>/.test(page));

  // ⚠️ 关键正确性：解锁必须在用户手势里，且不能 await 阻塞
  check(
    "解锁调用未被 await（不阻塞占卜开始）",
    /void unlockAmbience\(\)/.test(page),
    ""
  );

  // ⚠️ 开关组件本身
  check("开关有 aria-label", /aria-label=/.test(toggle));
  check("开关用了 useSyncExternalStore（非 set-state-in-effect）", /useSyncExternalStore/.test(toggle));
  // ⚠️ 断言要精确：useState 只在**真正的调用**里才是问题，
  //    出现在注释/字符串里的不算（踩过一次：注释里的 "useState" 被误判）。
  const realUseState = /(^|[^\w])useState\s*[(<]/m.test(toggle.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""));
  check("开关不用 useState（避免 set-state-in-effect）", !realUseState);
}

/* ────────────── ④ 版权安全 ────────────── */
console.log("\n【④ 版权与体积安全】");
{
  const src = readFileSync("src/lib/audio/ambient.ts", "utf-8");
  check("音频由 Web Audio 合成（无外部音频文件）", /createOscillator/.test(src));
  check("无 fetch 外部音源", !/fetch\(|https?:\/\/.*\.(mp3|ogg|wav|m4a)/.test(src));
  // ⚠️ 项目 public/ 下不应该有音频文件（体积 + 版权）
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
