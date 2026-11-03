#!/usr/bin/env node
/**
 * 验证 P2-⑨：仪式守卫覆盖全部工具 + advance().ok 不再被丢弃
 *
 * ⚠️ 为什么必须测：
 *   审计实测的两个问题：
 *     ① 守卫只覆盖 2 个工具（offer_card_selection / draw_cards），
 *        其余 6 个仪式工具**完全没有前置检查** → 模型可以跳步
 *        （实测 32/34 条 eval 用例的 contract/invocation/percard/closing 全缺）
 *     ② 8 处 `advance(...).phase` 全部**丢弃了 .ok**
 *        → 非法阶段转移完全无声 → 状态机形同虚设
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== P2-⑨ 仪式守卫覆盖验证 ===\n");

const machine = readFileSync(join(root, "src", "lib", "agent", "ritual-machine.ts"), "utf8");
const sup = readFileSync(join(root, "src", "lib", "agent", "supervisor.ts"), "utf8");

/* ---- ① 守卫表覆盖全部 8 个仪式工具 ---- */
const TOOLS = [
  "establish_contract",
  "invoke_three_questions",
  "offer_card_selection",
  "draw_cards",
  "reveal_card",
  "interpret_card",
  "write_reading",
  "close_reading",
];
{
  const missing = [];
  for (const t of TOOLS) {
    const re = new RegExp(`^\\s*${t}:\\s*"`, "m");
    if (!re.test(machine)) missing.push(t);
  }
  check(
    `守卫表覆盖全部 ${TOOLS.length} 个仪式工具`,
    missing.length === 0,
    missing.length ? `缺: ${missing.join(", ")}` : `全部在 TOOL_PHASE_REQUIREMENT 中`
  );
}

/* ---- ② 自由工具不在表里（不能被误拦）---- */
{
  const hasAsk = /^\s*ask_user:\s*"/m.test(machine);
  const hasRag = /^\s*rag_search:\s*"/m.test(machine);
  check(
    "ask_user / rag_search 不在守卫表（任何阶段都能调）",
    !hasAsk && !hasRag,
    hasAsk || hasRag ? "误加入守卫表 → 会阻断合法的澄清/检索" : "正确排除"
  );
}

/* ---- ③ supervisor 走统一入口（不再各分支各写一份）---- */
{
  const usesTable = /TOOL_PHASE_REQUIREMENT\[name\]/.test(sup);
  check(
    "supervisor 用 TOOL_PHASE_REQUIREMENT 查表做统一守卫",
    usesTable,
    usesTable ? "统一入口" : "未使用查表"
  );
  // 旧的分支内守卫应该已删除（避免两处判据漂移）
  const inlineGuard = /if \(name === "draw_cards"\) \{[\s\S]{0,600}?const guard = canEnter\(/.test(sup);
  const inlineGuard2 = /offer_card_selection"\) \{[\s\S]{0,600}?const guard = canEnter\(/.test(sup);
  check(
    "分支内的重复守卫已删除（判据只有一处）",
    !inlineGuard && !inlineGuard2,
    inlineGuard || inlineGuard2 ? "仍有重复守卫 → 会漂移" : "已清理"
  );
}

/* ---- ④ advance().ok 不再被丢弃 ---- */
{
  const discards = (sup.match(/\badvance\([^)]*\)\.phase/g) || []).length;
  check(
    "没有裸用 advance(...).phase（.ok 被丢弃）",
    discards === 0,
    discards === 0 ? "全部改用 advancePhase" : `仍有 ${discards} 处`
  );
  const usesAdvancePhase = (sup.match(/advancePhase\(/g) || []).length;
  check(
    "advancePhase 被实际调用（≥8 处）",
    usesAdvancePhase >= 8,
    `调用 ${usesAdvancePhase} 处`
  );
}

/* ---- ⑤ advancePhase 会记录非法转移 ---- */
{
  const logs = /console\.error\(\s*`\[ritual\] 非法阶段转移/.test(machine);
  check(
    "advancePhase 对非法转移打日志（可观测）",
    logs,
    logs ? "有日志" : "非法转移仍然无声"
  );
  const keepsOriginal = /if \(!r\.ok\) \{[\s\S]{0,400}?return r\.phase;/.test(machine);
  check(
    "advancePhase 非法转移时保持原阶段（不硬跳）",
    keepsOriginal,
    keepsOriginal ? "保持原阶段" : "行为异常"
  );
}

/* ---- ⑥ synthesis 的完成判据与守卫时序匹配 ---- */
{
  // ⚠️ 这是加守卫时踩到的真坑：
  //    close_reading 要求 synthesis 已完成，
  //    而 synthesis 完成于 write_reading 结束（早于会话结束）
  //    → 若用 finished 判断，守卫会永远拦截收束。
  const usesSynthesisDone = /s\.synthesisDone\) done\.add\("synthesis"\)/.test(machine);
  check(
    "synthesis 的完成判据是 synthesisDone（不是 finished）",
    usesSynthesisDone,
    usesSynthesisDone ? "时序正确" : "用 finished 判断 → 收束永远被拦"
  );
  const setsFlag = /session\.synthesisDone = true/.test(sup);
  check(
    "write_reading 完成后置位 synthesisDone",
    setsFlag,
    setsFlag ? "已置位" : "未置位"
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
