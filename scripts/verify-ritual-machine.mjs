#!/usr/bin/env node
/**
 * 验证占卜仪式状态机（P1-⑩）
 *
 * ⚠️ 为什么状态机必须有单测：
 *    状态机是"把散落的 if 收敛成一张表"的改造 ——
 *    改完之后，守卫的正确性完全依赖这张表。
 *    表写错了不会报错，只会让模型又能跳步（回到 2026-11 的原始 bug）。
 *    而且"合法转移"是可以穷举的 —— 不测就浪费了。
 *
 * ⚠️ 为什么是 .mjs 而不是 .ts：
 *    scripts/ 目录被 tsconfig 排除（exclude: ["scripts"]）——
 *    这些脚本是"运行时工具"，不参与应用构建，
 *    不该因为 import 路径后缀之类的小事卡住整个项目的 typecheck。
 *    所以脚本统一用 .mjs + 运行时校验（tsx 跑）。
 *
 * 验证五组：
 *   ① 正常路径：承约→呼召→选牌→逐张→综合→收束→完成，每步都合法
 *   ② 跳步被拦：承约未完成就抽牌 → 拒绝 + 指向正确的缺失阶段
 *   ③ 缺中间步被拦 + 前置齐备放行
 *   ④ 回退合法：用户否定承约 → 允许回到承约
 *   ⑤ 阶段推导：老会话（无 ritualPhase）能从字段反推正确阶段
 */

import {
  canEnter, canTransition, advance, derivePhase, nextActionHint, completedPhases,
  RITUAL_ORDER, RITUAL_PHASE_LABEL,
} from "../src/lib/agent/ritual-machine.ts";

let pass = 0;
let fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

console.log("=== 占卜仪式状态机验证 ===\n");
console.log(`阶段顺序: ${RITUAL_ORDER.map((p) => RITUAL_PHASE_LABEL[p]).join(" → ")}\n`);

/* ---- ① 正常路径全通 ---- */
{
  const path = [
    "contract", "invocation", "card_selection", "per_card", "synthesis", "closing", "done",
  ];
  const bad = [];
  for (let i = 0; i < path.length - 1; i++) {
    if (!canTransition(path[i], path[i + 1])) bad.push(`${path[i]}→${path[i + 1]}`);
  }
  check("正常路径每一步都合法", bad.length === 0, bad.length ? `非法: ${bad.join(", ")}` : "7 步全通");

  let phase = "contract";
  let advanceOk = true;
  for (const next of path.slice(1)) {
    const r = advance(phase, next);
    if (!r.ok) { advanceOk = false; break; }
    phase = r.phase;
  }
  check("advance() 逐级推进到 done", advanceOk && phase === "done", `最终 phase=${phase}`);
}

/* ---- ② 跳步被拦（缺的是"当前正在做的这一步"）---- */
{
  const g = canEnter("contract", "card_selection", new Set(), { toolName: "draw_cards" });
  check("承约未完成直接抽牌 → 被拦", !g.ok, g.ok ? "竟然放行了" : `缺「${g.missing ? RITUAL_PHASE_LABEL[g.missing] : "?"}」`);
  check("缺的是承约本身（不是呼召）", g.missing === "contract", g.missing ? RITUAL_PHASE_LABEL[g.missing] : "");
  check("拦截时给出可执行提示", !!(g.hint ?? "").includes("establish_contract"), (g.hint ?? "").slice(0, 46));
  check("提示里带工具名", !!(g.hint ?? "").includes("draw_cards"), "");

  const g2 = canEnter("invocation", "card_selection", new Set(["contract"]), { toolName: "draw_cards" });
  check("承约完成但没呼召 → 缺呼召", g2.missing === "invocation", g2.missing ? RITUAL_PHASE_LABEL[g2.missing] : "");
}

/* ---- ③ 缺中间步被拦 + 前置齐备放行 ---- */
{
  const done = new Set(["contract", "invocation"]);
  const g = canEnter("invocation", "synthesis", done, { toolName: "write_reading" });
  check("呼召后直接综合 → 被拦", !g.ok, g.ok ? "竟然放行了" : "");
  check("指出缺的是选牌", g.missing === "card_selection", g.missing ? `缺「${RITUAL_PHASE_LABEL[g.missing]}」` : "");

  const g2 = canEnter("card_selection", "synthesis", new Set([...done, "card_selection"]), { toolName: "write_reading" });
  check("选牌后直接综合 → 被拦", !g2.ok, g2.ok ? "竟然放行了" : "");
  check("指出缺的是逐张解读", g2.missing === "per_card", g2.missing ? `缺「${RITUAL_PHASE_LABEL[g2.missing]}」` : "");

  const g3 = canEnter("per_card", "synthesis", new Set(["contract", "invocation", "card_selection", "per_card"]), { toolName: "write_reading" });
  check("前置齐备 → 放行", g3.ok, g3.ok ? "" : `被拦：${(g3.hint ?? "").slice(0, 40)}`);
}

/* ---- ③b completedPhases 推导 ---- */
{
  check("空会话 → 无已完成阶段", completedPhases({}).size === 0);
  check("已承约 → 完成 1 项", completedPhases({ contractQuestion: "q" }).has("contract"));
  check("已呼召 → 完成 2 项", completedPhases({ contractQuestion: "q", invocation: { answers: ["a"] } }).has("invocation"));
  check("已抽牌 → 完成 3 项", completedPhases({ contractQuestion: "q", invocation: { answers: ["a"] }, drawnCards: [{}] }).has("card_selection"));
  check(
    "牌讲完 → 完成逐张",
    completedPhases({
      contractQuestion: "q", invocation: { answers: ["a"] }, drawnCards: [{}, {}],
      cardReadings: [{ reading: "a" }, { reading: "b" }],
    }).has("per_card")
  );
  check("只讲一半 → 不算讲完", !completedPhases({
    contractQuestion: "q", invocation: { answers: ["a"] }, drawnCards: [{}, {}],
    cardReadings: [{ reading: "a" }, {}],
  }).has("per_card"));
}

/* ---- ④ 回退合法 ---- */
{
  check("呼召 → 承约（回退重做）合法", canTransition("invocation", "contract"));
  check("选牌 → 承约（回退）合法", canTransition("card_selection", "contract"));
  check("逐张 → 选牌（回退）合法", canTransition("per_card", "card_selection"));
  check("终态不可回退", !canTransition("done", "contract"));
  check("不能跳过承约直达逐张", !canTransition("contract", "per_card"));
}

/* ---- ⑤ 阶段推导（老会话兼容）---- */
{
  check("全新会话 → 承约", derivePhase({}) === "contract", derivePhase({}));
  check("已承约 → 呼召", derivePhase({ contractQuestion: "问题？" }) === "invocation");
  check("已呼召 → 选牌", derivePhase({ contractQuestion: "q", invocation: { answers: ["a"] } }) === "card_selection");
  check(
    "已抽牌 → 逐张解读",
    derivePhase({
      contractQuestion: "q", invocation: { answers: ["a"] },
      drawnCards: [{}, {}], cardReadings: [],
    }) === "per_card"
  );
  check(
    "牌讲完 → 综合",
    derivePhase({
      contractQuestion: "q", invocation: { answers: ["a"] },
      drawnCards: [{}, {}],
      cardReadings: [{ reading: "解读1" }, { reading: "解读2" }],
    }) === "synthesis"
  );
  check("已结束 → done", derivePhase({ finished: true }) === "done");
  check(
    "牌只讲一半 → 仍在逐张",
    derivePhase({
      contractQuestion: "q", invocation: { answers: ["a"] },
      drawnCards: [{}, {}],
      cardReadings: [{ reading: "解读1" }, {}],
    }) === "per_card"
  );
}

/* ---- ⑥ 每阶段都有下一步提示 ---- */
{
  const missing = RITUAL_ORDER.filter((p) => !nextActionHint(p));
  check("每个阶段都有下一步提示", missing.length === 0, missing.join(", "));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
