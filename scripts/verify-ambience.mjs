#!/usr/bin/env node
/**
 * 验证：占卜配乐模块（防回归）
 *
 * ⚠️ 为什么音乐要写验证脚本：
 *   音频是"看不见的功能"—— 改坏了不会报错，只会觉得"怪怪的"。
 *   而且这里的每个断言都对应一条**具体踩过的坑**或一条设计契约：
 *   · 阶段映射漏一个 → 某个仪式阶段没有专属曲子（会静默沿用上一首）
 *   · 曲目文件名与 manifest 对不上 → 该阶段永远加载失败（静音）
 *   · sw.js 预缓存里混进音频 → 首屏预算被十几 MB 的 mp3 撑爆
 *   · 页面忘了 import 新的音频模块 → 运行时 404（模块不存在）
 *   · 无缝循环把头段播两遍 → 每轮循环都能听出"倒带"
 *
 * 用法：npx tsx scripts/verify-ambience.mjs
 */

import { existsSync, readFileSync, statSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== 占卜配乐验证 ===\n");

/** 去掉块注释与行注释，只看真实代码 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const read = (p) => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
};

/* ══════════ ① 模块结构 ══════════ */
console.log("【① 模块结构】（新架构取代旧的程序化合成）");
{
  const modules = ["engine", "score", "sfx", "air", "materials", "phase", "index"];
  for (const m of modules) {
    check(`存在 src/lib/audio/${m}.ts`, existsSync(`src/lib/audio/${m}.ts`));
  }
  check(
    "旧的程序化合成 ambient.ts 已删除",
    !existsSync("src/lib/audio/ambient.ts"),
    "配乐改为 AI 生成 + 事件音效 + 空气层"
  );
  check(
    "旧的离线渲染脚本 render-ambience.mjs 已删除",
    !existsSync("scripts/dev/render-ambience.mjs"),
    "由 analyze-score.mjs 取代"
  );
  check("新的离线分析脚本存在", existsSync("scripts/dev/analyze-score.mjs"));
}

/* ══════════ ② 阶段映射 ══════════ */
console.log("\n【② 阶段映射】（7 个仪式阶段 ↔ 7 首曲子）");
{
  const phaseSrc = read("src/lib/audio/phase.ts");
  const EXPECT = {
    contract: "contract",
    invocation: "invocation",
    card_selection: "selection",
    per_card: "perCard",
    synthesis: "synthesis",
    closing: "closing",
  };
  for (const [ritual, expected] of Object.entries(EXPECT)) {
    check(
      `仪式阶段 ${ritual} → 配乐阶段 ${expected}`,
      new RegExp(`case "${ritual}":\\s*return "${expected}"`).test(phaseSrc)
    );
  }
  check("未匹配阶段回落到 idle", /default:\s*return "idle"/.test(phaseSrc));
  check(
    "7 个配乐阶段齐备",
    ["idle", "contract", "invocation", "selection", "perCard", "synthesis", "closing"].every((p) =>
      phaseSrc.includes(`"${p}"`)
    )
  );
  check(
    "card_selection 与 per_card 是**不同的**曲子",
    /case "card_selection":\s*return "selection"/.test(phaseSrc) &&
      /case "per_card":\s*return "perCard"/.test(phaseSrc),
    "前者极稀疏（等你出手），后者才有旋律"
  );
}

/* ══════════ ③ 曲目文件与 manifest ══════════ */
console.log("\n【③ 曲目文件与 manifest】（资源完整性）");
{
  const PHASES = ["idle", "contract", "invocation", "selection", "percard", "synthesis", "closing"];
  const STYLES = ["A", "B"];
  let missing = 0;
  let tiny = 0;
  for (const s of STYLES) {
    for (const p of PHASES) {
      const f = `public/audio/score-${s}-${p}.mp3`;
      if (!existsSync(f)) {
        check(`存在 ${f}`, false);
        missing++;
        continue;
      }
      if (statSync(f).size < 100 * 1024) {
        check(`存在 ${f}`, false, `只有 ${(statSync(f).size / 1024).toFixed(0)}KB，疑似下载不完整`);
        tiny++;
      }
    }
  }
  if (!missing && !tiny) {
    check(`${STYLES.length * PHASES.length} 首曲目文件齐备且非空`, true);
  }

  const manifestPath = "public/audio/score.manifest.json";
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(read(manifestPath));
    const keys = Object.keys(manifest.tracks ?? {});
    const expected = STYLES.flatMap((s) => PHASES.map((p) => `score-${s}-${p}`));
    const missingKeys = expected.filter((k) => !keys.includes(k));
    check(
      "manifest 覆盖全部 14 首",
      missingKeys.length === 0,
      missingKeys.length ? `缺: ${missingKeys.join(", ")}` : `${keys.length} 首`
    );
    check(
      "manifest 记录了响度目标",
      typeof manifest.targetLufs === "number",
      `目标 ${manifest.targetLufs} LUFS`
    );
    const noGain = keys.filter((k) => typeof manifest.tracks[k].gainDb !== "number");
    check("每首都有响度修正增益", noGain.length === 0, noGain.join(", "));
  } else {
    check("manifest 存在（scripts/dev/analyze-score.mjs 生成）", false);
  }
}

/* ══════════ ④ 页面与组件接线 ══════════ */
console.log("\n【④ 接线】（模块换了，调用点必须跟着换）");
{
  const page = read("src/app/page.tsx");
  check("页面 import 了新音频模块", /from "@\/lib\/audio"/.test(page));
  check("页面不再 import 已删除的 ambient", !/from "@\/lib\/audio\/ambient"/.test(page));
  check("占卜开始仍解锁音频", /void unlockAmbience\(\)/.test(page));
  check("解锁后播放仪式起始音", /unlockAmbience\(\)[\s\S]{0,80}playSfx\("chime"\)/.test(page));
  check("页面挂了 useAmbiencePhase（阶段联动）", /useAmbiencePhase\(/.test(page));
  check("渲染了开关按钮", /<AmbienceToggle\s*\/>/.test(page));

  // ⚠️ 音效调用分散在 features/divination/ 下，要一起看
  const featureSrc = ["useCardActions.ts", "useFollowup.ts", "useStreamRunner.ts"]
    .map((f) => read(`src/features/divination/${f}`))
    .join("\n");
  check("features/divination 改用新音频模块", /from "@\/lib\/audio"/.test(featureSrc));
  check(
    "features/divination 不再 import 已删除的 ambient",
    !/from "@\/lib\/audio\/ambient"/.test(featureSrc)
  );
  check("翻牌音效仍在", /playSfx\("flip"\)/.test(page + featureSrc));
  check("答问音效仍在", /playSfx\("answer"\)/.test(page + featureSrc));

  const toggle = read("src/components/AmbienceToggle.tsx");
  check("开关组件 import 新模块", /from "@\/lib\/audio"/.test(toggle));
  check("音乐开关会解锁并开声", /unlockAmbience\(\)/.test(toggle) && /setMuted\(false\)/.test(toggle));
  check(
    "提示气泡可点击（点它即解锁 = 浏览器要的手势）",
    /onClick=\{\(\) => \{[\s\S]{0,260}unlockAmbience\(\)/.test(toggle)
  );
  check("提供风格切换（STYLE_ORDER）", /STYLE_ORDER/.test(toggle));
  check("状态用 useSyncExternalStore（不触发 set-state-in-effect）", /useSyncExternalStore/.test(toggle));
  check(
    "旧的 AmbienceGate 仍已删除",
    !existsSync("src/components/AmbienceGate.tsx") && !/<AmbienceGate/.test(page)
  );
}

/* ══════════ ⑤ 运行时契约 ══════════ */
console.log("\n【⑤ 运行时契约】（静态可验的行为保证）");
{
  const score = read("src/lib/audio/score.ts");
  const scoreCode = strip(score);

  check("配乐层用 fetch 懒加载（不是一次加载 14 首）", /fetch\(/.test(score));
  check("配乐层是文件播放（没有 createOscillator 合成）", !/createOscillator/.test(scoreCode));
  check("播放时开启循环", /src\.loop\s*=\s*true/.test(scoreCode));
  check("调用了无缝循环处理 makeLoopable", /makeLoopable\(/.test(scoreCode));
  check("无缝循环用等功率交叉淡化（sin/cos）", /Math\.cos\(\(t \* Math\.PI\) \/ 2\)/.test(scoreCode));
  check(
    "无缝循环的**主体跳过已淡入的头段**（否则头段播两遍）",
    /dst\[i\] = src\[i \+ F\]/.test(scoreCode),
    "头段截断 + 尾段前移 → 接缝处 src[F-1]→src[F] 连续"
  );
  check("阶段切换有交叉淡化", /CROSSFADE_SEC/.test(scoreCode) && /rampEqualPower/.test(scoreCode));
  check(
    "交叉淡化用等功率曲线（线性会塌陷）",
    /Math\.sin\(\(t \* Math\.PI\) \/ 2\)/.test(scoreCode)
  );
  check("切阶段前会复核当前状态（防竞态）", /trackKey\(eng\.style, eng\.phase\)/.test(scoreCode));
  check("解码失败时静默降级（不抛错打断仪式）", /catch\s*\{/.test(scoreCode));

  const engine = strip(read("src/lib/audio/engine.ts"));
  check("引擎用 globalThis 保存状态（HMR 安全）", /globalThis/.test(engine));
  check("主音量从 0 淡入（避免开场爆音）", /master\.gain\.value = 0/.test(engine));
  check(
    "音效层单独走混响（配乐自带混响，不再叠一层）",
    /convolver/.test(engine) && /scoreBus\.connect\(master\)/.test(engine)
  );

  // ⚠️ 体积保护：sw.js 的预缓存里绝不能出现音频
  const sw = read("public/sw.js");
  const precacheMatch = sw.match(/PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]/);
  const precache = precacheMatch ? precacheMatch[1] : "";
  check(
    "Service Worker 预缓存不含音频（首屏预算）",
    !/\/audio|\.mp3/.test(precache),
    precacheMatch ? "预缓存列表只有 manifest 与图标" : "未找到 PRECACHE_URLS"
  );

  // ⚠️ 模块级可变状态（CI 有 verify-runtime-state 守卫，这里再查一次音频模块）
  const audioFiles = ["engine", "score", "sfx", "air", "materials", "phase", "index"].map(
    (m) => `src/lib/audio/${m}.ts`
  );
  const offenders = [];
  for (const f of audioFiles) {
    for (const line of read(f).split("\n")) {
      if (
        /^let\s+\w+/.test(line) ||
        /^const\s+\w+\s*[:=][^=]*new\s+(Map|Set|WeakMap|WeakSet)\s*[<(]/.test(line)
      ) {
        offenders.push(`${f}: ${line.trim().slice(0, 60)}`);
      }
    }
  }
  check(
    "音频模块无模块级可变状态（必须收敛到 globalThis）",
    offenders.length === 0,
    offenders.length ? offenders.join("; ") : "7 个模块全部合规"
  );
}

/* ══════════ ⑥ 协议层：仪式阶段必须真的传到前端 ══════════ */
console.log("\n【⑥ 协议契约】（仪式阶段 → 前端配乐联动）");
{
  /**
   * ⚠️ 这一节防的是 2026-11-17 修的那个隐蔽 bug：
   *   前端拿**步骤标签**（analyze/retrieve/draw/interpret/wait_user）去匹配**仪式阶段**
   *   （contract/invocation/card_selection/per_card/synthesis/closing）。
   *   两套值完全不重叠 → 配乐永远停在 idle、阶段锣从来没响过，
   *   而且**不报任何错**（只是"永远匹配不上"）。
   *   → 所以协议必须显式带上 ritualPhase，链路每一环都要有断言。
   */
  const schema = read("src/lib/agent/schema.ts");
  const types = read("src/lib/agent/types.ts");
  const route = read("src/app/api/interpret/route.ts");
  const runner = read("src/features/divination/useStreamRunner.ts");
  const page = read("src/app/page.tsx");
  const phaseSrc = read("src/lib/audio/phase.ts");

  /* ---- ① 协议声明：zod 与手写 interface 必须同时有 ---- */
  check(
    "schema 定义了 RitualPhaseSchema（仪式阶段枚举）",
    /export const RitualPhaseSchema = z\.enum\(\[/.test(schema)
  );
  const RITUALS = ["contract", "invocation", "card_selection", "per_card", "synthesis", "closing"];
  const missingRitual = RITUALS.filter((r) => !schema.includes(`"${r}"`));
  check(
    "RitualPhaseSchema 覆盖全部 6 个仪式阶段",
    missingRitual.length === 0,
    missingRitual.length ? `缺: ${missingRitual.join(", ")}` : RITUALS.join(" / ")
  );
  check(
    "phase 事件在 zod 里声明了 ritualPhase（zod 会剥离未声明字段）",
    /type: z\.literal\("phase"\)[\s\S]{0,400}?ritualPhase: RitualPhaseSchema\.optional\(\)/.test(schema),
    "不声明的话前端永远收不到"
  );
  check(
    "AgentEvent 接口也声明了 ritualPhase（它才是真正的类型源）",
    /ritualPhase\?: import\("\.\/ritual-machine"\)\.RitualPhase/.test(types),
    "schema.ts 只是并行校验源，类型来自 types.ts"
  );

  /* ---- ② 服务端：在唯一事件出口富化 ---- */
  check(
    "API 路由在事件出口给 phase 事件补上 ritualPhase",
    /evt\.type === "phase" && session\.ritualPhase[\s\S]{0,120}ritualPhase: session\.ritualPhase/.test(route),
    "路由是唯一出口 → 一次补齐，永不漏"
  );
  check(
    "富化后的事件真的被发出去（不是只声明没用）",
    /send\(enriched/.test(route) && /recordEvent\(sid, enriched\)/.test(route)
  );

  /* ---- ③ 前端：捕获 → 存状态 ---- */
  check(
    "useStreamRunner 捕获 phase 事件里的 ritualPhase",
    /if \(p\.ritualPhase !== undefined\)/.test(runner) && /setRitualPhase\(p\.ritualPhase\)/.test(runner)
  );
  check(
    "阶段锣按**仪式阶段变化**播（不是步骤标签）",
    /STAGE_GONG_PHASES\.includes\(p\.ritualPhase\)/.test(runner),
    "旧实现是 includes(p.phase) → 永远不响"
  );
  check(
    "阶段锣只在仪式阶段**真的变了**时播一次",
    /prevRitual !== null &&[\s\S]{0,80}prevRitual !== p\.ritualPhase/.test(runner),
    "否则一个阶段连响好几次 → 变成噪音"
  );
  check(
    "旧的按步骤标签匹配锣阶段的写法已消失",
    !/STAGE_GONG_PHASES\.includes\(p\.phase\)/.test(runner)
  );

  /* ---- ④ 页面：用仪式阶段驱动配乐 ---- */
  check(
    "页面用 ritualPhase 驱动配乐联动",
    /useAmbiencePhase\(ritualPhase\)/.test(page),
    "必须是 ritualPhase —— 步骤标签推不出仪式阶段"
  );
  check(
    "页面不是用步骤标签驱动配乐",
    !/useAmbiencePhase\(phase\)/.test(page)
  );
  const resets = (page.match(/setRitualPhase\(null\)/g) ?? []).length;
  check(
    "新一场占卜会重置 ritualPhase（否则残留上一场的阶段）",
    resets >= 2,
    `找到 ${resets} 处重置`
  );

  /* ---- ⑤ 映射闭环：协议里的阶段值能被配乐层认出 ---- */
  const unmapped = RITUALS.filter(
    (r) => !new RegExp(`case "${r}":\\s*return "`).test(phaseSrc)
  );
  check(
    "协议里的每个仪式阶段都有配乐映射",
    unmapped.length === 0,
    unmapped.length ? `未映射: ${unmapped.join(", ")}` : "6 个阶段全部有曲子"
  );
}

/* ══════════ ⑦ 缺陷回归防护（2026-11-17 审查补） ══════════ */
console.log("\n【⑦ 缺陷回归防护】（审查发现的真实问题，钉死不许回退）");
{
  const score = read("src/lib/audio/score.ts");
  const scoreCode = strip(score);
  const index = read("src/lib/audio/index.ts");
  const types = read("src/features/divination/types.ts");

  /* ---- ① 关掉配乐后，正在加载的曲子不能又响起来 ---- */
  const loadIdx = scoreCode.indexOf("await loadTrack");
  const recheckIdx = scoreCode.indexOf("if (!eng.unlocked || !eng.scoreEnabled)");
  check(
    "加载/解码完成后**复核**配乐开关（否则关了又响）",
    loadIdx >= 0 && recheckIdx > loadIdx,
    "fetch + decode 是异步的 → 这期间用户可能点了「♪ 关闭配乐」"
  );
  check(
    "复核不通过时真的把声音停了（不是只 return）",
    /if \(!eng\.unlocked \|\| !eng\.scoreEnabled\) \{\s*stopScore\(\);/.test(scoreCode)
  );

  /* ---- ② 阶段锣要覆盖「讲牌」这个仪式高潮 ---- */
  const gongBlock = types.match(/STAGE_GONG_PHASES[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "";
  check(
    "阶段锣覆盖呼召 / 选牌 / **讲牌** / 综合 / 收束",
    ["invocation", "card_selection", "per_card", "synthesis", "closing"].every((p) =>
      gongBlock.includes(`"${p}"`)
    ),
    gongBlock.replace(/\s+/g, " ").trim()
  );

  /* ---- ③ 不留"承诺了但没人用"的预取 API ---- */
  check(
    "没有未启用的预取 API（承诺了却没人调用 = 误导）",
    !/preloadScore/.test(score) && !/preloadScore/.test(index)
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);