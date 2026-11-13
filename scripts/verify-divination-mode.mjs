#!/usr/bin/env node
/**
 * 验证：占卜双模式（快速一问 / 深度解读）—— 2026-11-04
 *
 * ⚠️ 为什么需要这份脚本：
 *   双模式改的是**仪式路径**（跳过哪些阶段、等不等用户）——
 *   这类改动最危险的失败模式是"**守卫死锁**"：
 *   快速模式跳过呼召 → invocation 永远不在已完成集合里 →
 *   如果守卫还检查全部前置，选牌会被**永久拦截** → 占卜直接卡死。
 *   而且这种故障只在"选了快速模式"时才出现 —— 深度模式完全正常。
 *   → 必须有专门的守卫。
 *
 * 断言分四组：
 *   ① 模式定义（单一事实源）
 *   ② 守卫的模式感知（不死锁 + 向后兼容）
 *   ③ 快速模式的仪式路径（跳过什么 / 保留什么）
 *   ④ 前后端接线
 *
 * 用法：npx tsx scripts/verify-divination-mode.mjs
 */

import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

console.log("=== 占卜双模式验证 ===\n");

/* ────────────── ① 模式定义 ────────────── */
console.log("【① 模式定义】");
{
  const exists = existsSync("src/lib/agent/divination-mode.ts");
  check("divination-mode.ts 存在", exists);
  if (exists) {
    const mod = await import("../src/lib/agent/divination-mode.ts").catch((e) => ({ __err: e }));
    if (mod.__err) {
      check("能 import 模式模块", false, String(mod.__err).slice(0, 90));
    } else {
      check("能 import 模式模块", true);

      // ⚠️ 两种模式都要有档案
      for (const m of ["quick", "deep"]) {
        const p = mod.MODE_PROFILES?.[m];
        check(`${m} 模式有档案`, !!p, p ? `${p.label} / ${p.tagline}` : "缺失");
      }

      // ⚠️ 关键属性：快速模式必须跳过呼召、不逐张
      check("快速模式跳过呼召三问（HITL 交互 10→3 的主要来源）",
        mod.MODE_PROFILES?.quick?.useInvocation === false);
      check("深度模式保留呼召三问",
        mod.MODE_PROFILES?.deep?.useInvocation === true);
      check("快速模式一次讲完（不逐张翻/不逐张提问）",
        mod.MODE_PROFILES?.quick?.perCardGated === false);
      check("深度模式逐张讲（保留仪式节奏）",
        mod.MODE_PROFILES?.deep?.perCardGated === true);

      // ⚠️ 承约必须两种模式都保留（仪式核心）
      const quickReq = mod.requiredPhases?.("quick");
      const deepReq = mod.requiredPhases?.("deep");
      check("承约在两种模式下都必需（仪式核心不能砍）",
        quickReq?.has("contract") && deepReq?.has("contract"));
      check("呼召只在深度模式必需", !quickReq?.has("invocation") && deepReq?.has("invocation"));
      check("选牌/逐张/综合/收束在两种模式下都必需",
        ["card_selection", "per_card", "synthesis", "closing"].every(
          (p) => quickReq?.has(p) && deepReq?.has(p)
        ));

      // ⚠️ 默认模式 = 快速（用户确认）
      check("默认模式是 quick（用户确认）", mod.DEFAULT_MODE === "quick");

      // ⚠️ 宽容解析（mode 来自 HTTP body，客户端可控）
      check("resolveMode 接受合法值", mod.resolveMode?.("quick") === "quick" && mod.resolveMode?.("deep") === "deep");
      check("resolveMode 对非法值退回默认（不抛错）",
        mod.resolveMode?.("garbage") === mod.DEFAULT_MODE &&
        mod.resolveMode?.(null) === mod.DEFAULT_MODE &&
        mod.resolveMode?.(undefined) === mod.DEFAULT_MODE &&
        mod.resolveMode?.(123) === mod.DEFAULT_MODE);
      check("modeProfile 对非法模式返回有效档案（不崩）",
        !!mod.modeProfile?.("nonsense")?.label);
    }
  }
}

/* ────────────── ② 守卫的模式感知 ────────────── */
console.log("\n【② 守卫的模式感知】（防守卫死锁）");
{
  const rm = await import("../src/lib/agent/ritual-machine.ts").catch((e) => ({ __err: e }));
  if (rm.__err) {
    check("能 import 状态机模块", false, String(rm.__err).slice(0, 90));
  } else {
    check("能 import 状态机模块", true);

    const completed = new Set(["contract"]);

    // ⚠️ 关键回归：快速模式承约完 → 选牌**必须**放行
    const quickGuard = rm.canEnter("contract", "card_selection", completed, { toolName: "offer_card_selection" }, "quick");
    check("快速模式：承约完可以进选牌（守卫不死锁）",
      quickGuard.ok, quickGuard.ok ? "" : quickGuard.hint?.slice(0, 90));

    // ⚠️ 深度模式承约完 → 选牌**必须**被拦（呼召未完成）
    const deepGuard = rm.canEnter("contract", "card_selection", completed, { toolName: "offer_card_selection" }, "deep");
    check("深度模式：承约完不能直接选牌（缺呼召）",
      !deepGuard.ok && deepGuard.missing === "invocation",
      `missing=${deepGuard.missing}`);

    // ⚠️ 向后兼容：不传 mode = deep（老会话行为不变）
    const legacyGuard = rm.canEnter("contract", "card_selection", completed, { toolName: "offer_card_selection" });
    check("不传 mode 时按 deep 处理（老会话兼容）",
      !legacyGuard.ok && legacyGuard.missing === "invocation");

    // ⚠️ 两种模式下"综合"都必须被拦住（没讲完牌不能综合）
    // ⚠️ 注意：缺哪个阶段取决于模式的必需集合 ——
    //   快速模式缺 per_card；深度模式还缺 invocation（呼召也是必需的）
    //   断言的是**安全属性**（都被拦住），不是具体缺哪个。
    const qSynthesis = rm.canEnter("card_selection", "synthesis", new Set(["contract", "card_selection"]), { toolName: "write_reading" }, "quick");
    check("快速模式：未讲完牌不能综合", !qSynthesis.ok && qSynthesis.missing === "per_card");
    const dSynthesis = rm.canEnter("card_selection", "synthesis", new Set(["contract", "card_selection"]), { toolName: "write_reading" }, "deep");
    check("深度模式：未讲完牌不能综合（且呼召也是必需前置）",
      !dSynthesis.ok && dSynthesis.missing === "invocation",
      `missing=${dSynthesis.missing}`);
    // ⚠️ 深度模式把呼召标为已完成后的行为 —— 缺的就应该是 per_card 了
    const dSynthesis2 = rm.canEnter("card_selection", "synthesis", new Set(["contract", "card_selection", "invocation"]), { toolName: "write_reading" }, "deep");
    check("深度模式：呼召已完成但牌没讲完 → 仍然拦住", !dSynthesis2.ok && dSynthesis2.missing === "per_card");

    // ⚠️ 转移表：contract → card_selection 必须合法（快速模式要跳过去）
    check("转移表允许 contract → card_selection（快速模式跳过呼召）",
      rm.canTransition("contract", "card_selection"));
    check("转移表仍然禁止非法跳跃（如 contract → synthesis）",
      !rm.canTransition("contract", "synthesis"));

    // ⚠️ nextActionHint 在快速模式下不能说"去问三问"
    const quickHint = rm.nextActionHint?.("invocation", "quick") ?? "";
    check("快速模式的引导语不会让模型去问三问",
      /不要调用 invoke_three_questions/.test(quickHint), quickHint.slice(0, 60));
    const deepHint = rm.nextActionHint?.("invocation", "deep") ?? "";
    check("深度模式的引导语仍然提示问三问",
      /invoke_three_questions/.test(deepHint));
  }
}

/* ────────────── ③ 快速模式的仪式路径 ────────────── */
console.log("\n【③ 快速模式的仪式路径】");
{
  const sup = readFileSync("src/lib/agent/supervisor.ts", "utf-8");
  const supCode = strip(sup);

  check("supervisor 按模式取档案", /modeProfile\(session\.mode/.test(supCode));
  // ⚠️ 判据用**代码特征**而不是注释文本（注释在剥离后就没了）：
  //   快速分支的存在 + 它不 await 用户回答
  check("快速模式：reveal_card 有不等待的快速分支",
    /if \(quickMode\)/.test(supCode) && /quickSlot\.flipped = true/.test(supCode));
  check("快速模式：快速分支里没有 await 用户回答",
    (() => {
      const m = supCode.match(/if \(quickMode\)[\s\S]*?continue;\s*\}/);
      return !!m && !/await /.test(m[0]);
    })(),
    "快速分支不阻塞在 HITL 上");
  check("快速模式：仍下发 card_reveal（用户必须看到牌）",
    /type: "card_reveal"/.test(supCode));
  check("快速模式：interpret_card 支持一次讲多张（card_indexes + readings）",
    /args\.card_indexes/.test(supCode) && /args\.readings/.test(supCode));
  check("快速模式：多张解读也有守卫（必须已揭示）",
    /notRevealed/.test(supCode));
  check("快速模式：拦截 invoke_three_questions",
    /快速模式不需要三问呼召/.test(supCode));
  check("快速模式：承约完直接进选牌（跳过呼召阶段）",
    /contractMode === "quick" \? "card_selection" : "invocation"/.test(supCode));
  check("守卫调用传入了 mode", /completedPhases\(session\),\s*\{ toolName: name \},\s*mode/.test(supCode));

  // ⚠️ 深度模式路径必须完全保留（不能被快速模式改坏）
  check("深度模式的逐张闸门仍在（等用户翻牌）",
    /flipWait/.test(supCode) && /confirmWait/.test(supCode));
  check("深度模式的 interpret_card 单张路径仍在",
    /args\.card_index/.test(supCode));
}

{
  // system prompt 必须告诉模型这是快速模式
  const helpers = readFileSync("src/lib/agent/helpers.ts", "utf-8");
  const helpersCode = strip(helpers);
  check("system prompt 注入模式说明（守卫管流程，prompt 管表达）",
    /快速一问/.test(helpersCode) && /modeNote/.test(helpersCode));
  check("快速模式 prompt 明确要求一次讲完",
    /card_indexes/.test(helpersCode));
}

/* ────────────── ③b 快速模式的轮次优化（实测踩坑后的修复） ────────────── */
console.log("\n【③b 快速模式的轮次优化】（实测：曾撞 max_rounds）");
{
  const sup = readFileSync("src/lib/agent/supervisor.ts", "utf-8");
  const supCode = strip(sup);
  const defs = readFileSync("src/lib/agent/tools/definitions.ts", "utf-8");
  const defsCode = strip(defs);
  const rag = readFileSync("src/lib/agent/tools/rag.ts", "utf-8");
  const ragCode = strip(rag);

  // ⚠️ 核心：快速模式必须有**专用工具**（模型才不会逐张调用）
  check("定义了快速模式专用工具 interpret_all_cards",
    /interpret_all_cards/.test(defsCode));
  check("interpret_all_cards 的 required 只有数组（模型没有单张选项）",
    /required: \["card_indexes", "readings"\]/.test(defsCode));
  check("快速模式工具集里没有 interpret_card",
    /QUICK_MODE_TOOLS[\s\S]*?TOOLS\.filter\(\(t\) => t\.function\.name !== "interpret_card"\)/.test(defsCode));
  check("提供 toolsForMode（按模式取工具集）", /export function toolsForMode/.test(defsCode));
  check("supervisor 用 toolsForMode 而非固定 TOOLS",
    /toolsForMode\(session\.mode/.test(supCode) && !/const availableTools = ragBanned \? TOOLS/.test(supCode));

  // ⚠️ 检索预算按模式
  check("检索预算按模式（快速 2 次）", /ragBudgetFor/.test(ragCode) && /session\.mode === "quick" \? 2/.test(ragCode));
  check("execRagSearch 用 ragBudgetFor", /session\.ragCallCount >= budget/.test(ragCode));
  check("supervisor 的下架判定也用 ragBudgetFor", /ragBanned = session\.ragCallCount >= ragBudgetFor/.test(supCode));

  // ⚠️ 临期催促点按模式提前（快速流程短，晚了就撞墙）
  check("临期催促点按模式区分（快速模式更早）",
    /session\.mode === "quick"\s*\?\s*Math\.max\(6, MAX_ROUNDS - 4\)/.test(supCode));
  check("快速模式的催促提示按状态区分（牌没讲完时不说 write_reading）",
    /allRevealed/.test(supCode) && /一次 interpret_card 传 card_indexes \+ readings/.test(supCode));

  // ⚠️ reveal_card 也支持批量
  check("reveal_card 支持一次揭示多张（card_indexes）",
    /args\.card_indexes/.test(supCode) && /revealIdxs/.test(supCode));

  // ⚠️ 批量工具也要过阶段守卫
  const rm = readFileSync("src/lib/agent/ritual-machine.ts", "utf-8");
  check("interpret_all_cards 也登记在阶段守卫表（不能凭空讲牌）",
    /interpret_all_cards: "per_card"/.test(rm));
}
/* ────────────── ④ 前后端接线 ────────────── */
console.log("\n【④ 前后端接线】");
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
  const pageCode = strip(page);
  // ⚠️ 2026-11-12 拆分：状态搬进了 useDivinationState → 断言要同时看两处
  const stateHookCode = strip(
    readFileSync("src/features/divination/useDivinationState.ts", "utf-8")
  );
  const frontCode = pageCode + "\n" + stateHookCode;
  const route = readFileSync("src/app/api/interpret/route.ts", "utf-8");
  const routeCode = strip(route);
  const sess = readFileSync("src/lib/agent/session.ts", "utf-8");
  const types = readFileSync("src/lib/agent/types.ts", "utf-8");

  check("页面有 mode state", /useState<DivinationMode>/.test(frontCode));
  check("页面默认 quick", /useState<DivinationMode>\(DEFAULT_MODE\)/.test(frontCode));
  // ⚠️ 2026-11-12 拆分：请求体改由 fetchStream 发送（不再是 JSON.stringify 字面量）
//    → 断言改为"mode 与 question 出现在同一个请求体里"（意图不变）
check(
  "前端把 mode 发给后端",
  /mode\s*\}/.test(pageCode) &&
    (/JSON\.stringify\(\{ question: q[^}]*mode/.test(pageCode) ||
      /fetchStream\([\s\S]{0,200}?question: q[\s\S]{0,200}?mode/.test(pageCode))
);
  check("前端有模式切换 UI", /MODE_PROFILES/.test(pageCode) && /aria-pressed/.test(pageCode));

  check("API 接受 mode 参数", /mode\?: string/.test(routeCode));
  check("API 用 resolveMode 宽容解析", /resolveMode\(body\.mode\)/.test(routeCode));
  // ⚠️ 2026-11-04 D 方向：createSession 多了 kind 参数 → 断言放宽
  //    （"mode 在第 4 个参数位"这个契约仍然成立，只是不再是最后一个）
  check("API 把 mode 传给 createSession", /createSession\(question, body\.persona, userKey, mode/.test(routeCode));

  check("session 类型有 mode 字段", /mode\?: import\("\.\/divination-mode"\)\.DivinationMode/.test(types));
  check("createSession 接受 mode 参数", /mode: DivinationMode = DEFAULT_MODE/.test(sess));
  check("快照含 mode（恢复后保持同一模式）",
    /mode: s\.mode/.test(sess) && /mode\?: DivinationMode/.test(sess));
  check("恢复时老会话按 deep 处理（不能按 quick —— 会跳过已完成阶段）",
    /mode: snap\.mode \?\? "deep"/.test(sess));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
