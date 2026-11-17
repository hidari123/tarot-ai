#!/usr/bin/env node
/**
 * 验证：配乐**音色质量**（设计契约）
 *
 * ⚠️ 为什么需要这个脚本：
 *   「听着难受」是最难防回归的一类问题：
 *   ① 它不像功能 bug 那样会报错，只是「听着刺耳 / 干 / 薄」
 *   ② 下一个重构者很容易觉得「这些参数是历史包袱」就删掉
 *   ③ CI 里没有任何东西能发现「音色退化」
 *
 * ⚠️ 断言的是**设计契约**（代码里必须存在哪些要素），不是「文件存在」：
 *   每一项都对应一条具体的听感问题 → 删掉任何一项，CI 会红。
 *
 * ⚠️ 契约清单（每条 = 一个具体的耳朵能听出来的问题）：
 *   ① **单一材质** —— 配乐与事件音效来自同一种物理材料
 *      问题：材质不统一 → 翻牌声像"另一个东西"跳出来
 *   ② **揭示音用非谐波泛音** —— 1 : 1.5 : 2
 *      问题：整数倍泛音 → 听起来像风琴（电子感），不是颂钵（神秘感）
 *   ③ **事件音效尾巴有上限** —— 衰减 ≤ 3.5s
 *      问题：长衰减 → 与配乐下一个乐句叠成"嗡" → 刺耳
 *   ④ **空气层极低电平** —— ≤ -38dBFS
 *      问题：底噪太响 → 变成"沙沙声"抢戏（这是旧实现被抱怨的核心）
 *   ⑤ **主音量从 0 淡入**
 *      问题：直接给音量 → 开场"啪"一声
 *   ⑥ **配乐层不含振荡器合成**
 *      问题：又退回程序化合成 → 回到"底噪"时代
 *   ⑦ **没有持续纯音（drone / shimmer）**
 *      问题：220/440Hz 纯音落在人耳最敏感频段 → "很长很长的空鸣声"
 *   ⑧ **响度已归一且有据可查**
 *      问题：14 首响度不一致 → 切阶段音量跳变
 *   ⑨ **音色整形后同风格一致**
 *      问题：切阶段像"换了个乐器"
 *
 * 用法：npx tsx scripts/verify-ambience-tone.mjs
 */

import { existsSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== 配乐音色质量验证 ===\n");

/** 去掉块注释与行注释，只看真实代码 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const read = (p) => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
};

const materials = strip(read("src/lib/audio/materials.ts"));
const sfx = strip(read("src/lib/audio/sfx.ts"));
const score = strip(read("src/lib/audio/score.ts"));
const air = strip(read("src/lib/audio/air.ts"));
const engine = strip(read("src/lib/audio/engine.ts"));

/* ══════════ ① 单一材质 ══════════ */
console.log("【① 单一材质】（配乐与音效来自同一种材料）");
{
  check("materials.ts 定义了材质参数", /MATERIALS/.test(materials));
  check(
    "事件音效从材质取参数（不写死频率）",
    /MATERIALS\[eng\.style\]/.test(sfx) && /mat\./.test(sfx),
    "翻牌/揭示/锣的频率全部由材质决定"
  );
  // ⚠️ 反面检查：sfx.ts 里不该出现裸的频率字面量（如 523.25）
  const literals = sfx.match(/\b\d{3,4}\.\d{2}\b/g) ?? [];
  check(
    "sfx.ts 没有写死的具体频率",
    literals.length === 0,
    literals.length ? `发现: ${literals.slice(0, 5).join(", ")}` : "全部走材质"
  );
  check("材质含翻牌的表面质感参数", /flipNoiseHz/.test(materials) && /flipThumpHz/.test(materials));
  check(
    "材质区分「有余响」与「无余响」（玻璃 vs 水）",
    /flipPingHz/.test(materials) && /flipPingHz: 0/.test(materials),
    "这是材质差异最直观的听感"
  );
}

/* ══════════ ② 揭示音 ══════════ */
console.log("\n【② 牌面揭示音】（全应用最重要的一下）");
{
  check("揭示音使用非谐波泛音（1.5 倍）", /1\.5/.test(materials));
  check("揭示音有多层泛音", /revealPartials:\s*\[[^\]]*1\.5[^\]]*\]/.test(materials));
  check("揭示音有明确的衰减时长", /revealDecay/.test(materials));
  const decay = [...materials.matchAll(/revealDecay:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "揭示音衰减 ≤ 2.5s（长尾巴会叠成「嗡」）",
    decay.length > 0 && decay.every((d) => d <= 2.5),
    decay.map((d) => `${d}s`).join(" / ")
  );
  const gong = [...materials.matchAll(/gongDecay:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "阶段锣衰减 ≤ 3.5s",
    gong.length > 0 && gong.every((d) => d <= 3.5),
    gong.map((d) => `${d}s`).join(" / ")
  );
  check("揭示音是事件音里最响的（gains 系数最大）", /0\.075/.test(sfx));
}

/* ══════════ ③ 空气层 ══════════ */
console.log("\n【③ 空气层】（存在感，不是可听度）");
{
  const gain = [...air.matchAll(/gain\.gain\.value = ([\d.]+)/g)].map((m) => Number(m[1]));
  check(
    "空气层电平 ≤ 0.012（≈ -38dBFS）",
    gain.length > 0 && gain.every((g) => g <= 0.012),
    gain.map((g) => g.toFixed(3)).join(" / ")
  );
  check("用粉噪声而不是白噪声（白噪声像电流沙沙）", /pink|Pink/i.test(air));
  check("有高通（切掉手机放不出的超低频）", /highpass/.test(air));
  check("有极慢的呼吸调制（不是死板一层）", /lfo/i.test(air) && /0\.04/.test(air));
}

/* ══════════ ④ 总线与淡入 ══════════ */
console.log("\n【④ 总线与淡入】（无爆音 / 混响不叠叠）");
{
  check("主音量从 0 淡入（避免开场爆音）", /master\.gain\.value = 0/.test(engine));
  check("静音是渐变而不是硬切", /linearRampToValueAtTime\(muted \? 0 : st\.volume/.test(engine));
  check(
    "配乐直连 master（AI 曲子自带混响，不再叠一层）",
    /scoreBus\.connect\(master\)/.test(engine),
    "叠两层混响会变浑浊"
  );
  check("音效单独走混响发送（让合成音和配乐待在同一空间）", /sfxBus\.connect\(send\)/.test(engine));
  check("三层总线齐备（score / sfx / air）", /scoreBus/.test(engine) && /sfxBus/.test(engine) && /airBus/.test(engine));
}

/* ══════════ ⑤ 没有"空鸣"源头 ══════════ */
console.log("\n【⑤ 没有「空鸣」源头】（旧实现最大的坑）");
{
  const all = score + sfx + air + engine;
  check("没有 drone 体系", !/makeDrone|drone/i.test(all));
  check("没有 shimmer 叠层", !/shimmer/i.test(all));
  check(
    "配乐层不含振荡器（纯文件播放）",
    !/createOscillator/.test(score),
    "回到程序化合成 = 回到「底噪」时代"
  );
  check(
    "没有落在人耳敏感区的持续纯音",
    !/220|440/.test(sfx.replace(/revealBase[\s\S]{0,20}/g, "")),
    "事件音是一次性的，不是持续音"
  );
}

/* ══════════ ⑥ 响度与音色（离线测量的结果） ══════════ */
console.log("\n【⑥ 离线测量结果】（manifest 里的客观指标）");
{
  const manifestPath = "public/audio/score.manifest.json";
  if (!existsSync(manifestPath)) {
    check("manifest 存在", false, "先跑 node scripts/dev/analyze-score.mjs");
  } else {
    const manifest = JSON.parse(read(manifestPath));
    const tracks = Object.entries(manifest.tracks ?? {});

    check("manifest 有响度目标", typeof manifest.targetLufs === "number", `${manifest.targetLufs} LUFS`);
    check("manifest 有风格音色目标", !!manifest.styleTargetCentroid);

    const noGain = tracks.filter(([, t]) => typeof t.gainDb !== "number");
    check("每首都有响度修正增益", noGain.length === 0, noGain.map(([k]) => k).join(", "));

    const noLp = tracks.filter(([, t]) => typeof t.lowpassHz !== "number");
    check("每首都有音色修正（低通截止）", noLp.length === 0);

    // ⚠️ 关键：整形后同风格的重心极差必须小
    for (const style of ["A", "B"]) {
      const vals = tracks
        .filter(([, t]) => t.style === style)
        .map(([, t]) => t.centroidAfter)
        .filter((v) => typeof v === "number");
      const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 999;
      check(
        `风格 ${style} 整形后重心极差 < 300Hz`,
        spread < 300,
        `${spread}Hz（${vals.length} 首）`
      );
    }

    const failed = tracks.filter(([, t]) => Object.values(t.checks ?? {}).some((v) => v === false));
    check(
      "每首曲目的客观检查全部通过",
      failed.length === 0,
      failed.map(([k, t]) => `${k}:${JSON.stringify(t.checks)}`).join("; ")
    );

    const short = tracks.filter(([, t]) => (t.duration ?? 0) < 30);
    check(
      "没有过短的曲子（< 30s 循环太密）",
      short.length === 0,
      short.map(([k, t]) => `${k}(${t.duration}s)`).join(", ")
    );
  }
}

/* ══════════ ⑦ 阶段弧线 ══════════ */
console.log("\n【⑦ 阶段弧线】（仪式要有情绪走向）");
{
  const phaseSrc = read("src/lib/audio/phase.ts");
  check("7 个阶段齐备", ["idle", "contract", "invocation", "selection", "perCard", "synthesis", "closing"].every((p) => phaseSrc.includes(`"${p}"`)));
  check(
    "选牌阶段与讲牌阶段是不同曲子（张力 vs 叙事）",
    /case "card_selection":\s*return "selection"/.test(phaseSrc) &&
      /case "per_card":\s*return "perCard"/.test(phaseSrc)
  );
  check(
    "阶段切换用交叉淡化（不是硬切）",
    /CROSSFADE_SEC/.test(score) && /rampEqualPower/.test(score),
    "3 秒等功率重叠 → 听起来是「转段」"
  );
  check(
    "交叉淡化用等功率而非线性（线性中间会塌音量）",
    /Math\.sin\(\(t \* Math\.PI\) \/ 2\)/.test(score)
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
