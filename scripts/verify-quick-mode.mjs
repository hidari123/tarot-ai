#!/usr/bin/env node
/**
 * 快速模式流程断言（2026-11-06）
 *
 * ⚠️ 为什么需要这个断言（用户报告的真实 bug）：
 *   "快速问答会走抽牌流程、先三张牌面都出了又走抽牌流程、翻不过来图、
 *    最后报错说达到最大轮次"。
 *
 * ⚠️ 根因（已修复）：
 *   close_reading 的守卫检查 `slot.reading`，
 *   而快速模式 `perCardGated: false` → 不做 interpret_card → reading 永远为空
 *   → 守卫永远拦截 → 模型反复重试 → 撞 max_rounds。
 *
 * ⚠️⚠️ 为什么这个断言检查**源码结构**而不是跑真实流程：
 *   真实流程要调 LLM（30~90 秒 + 花钱），不能进 CI。
 *   → 这里断言**修复所依赖的关键代码结构**存在且正确；
 *     真实流程由 scripts/dev/e2e-quick.mjs 验证（手动跑）。
 */

import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`);
  }
}

const sup = readFileSync("src/lib/agent/supervisor.ts", "utf-8");
const mode = readFileSync("src/lib/agent/divination-mode.ts", "utf-8");
const defs = readFileSync("src/lib/agent/tools/definitions.ts", "utf-8");

console.log("【快速模式收束守卫】");

// ① 守卫必须按模式分支（快速看 reveal，深度看 reading）
check(
  "close_reading 守卫按模式分支（快速模式用 reveal 而非 reading）",
  /quickCloseMode[\s\S]{0,400}!\s*slot\?\.(reveal|reading)/.test(sup),
  "未找到 quickCloseMode 分支"
);

// ② 快速模式必须放行"已揭示"的牌
check(
  "快速模式完成条件是「已揭示」",
  /quickCloseMode\s*\?\s*!\s*slot\?\.\s*reveal\s*:\s*!\s*slot\?\.\s*reading/.test(sup),
  "未找到 reveal/reading 分支"
);

// ③ 必须有兜底：快速模式缺 reading 时用牌面叙述补上
check(
  "快速模式有兜底（缺 reading 时用牌面叙述补上）",
  /quickCloseMode[\s\S]{0,400}sl\.reading\s*=\s*sl\.reveal\.narrative/.test(sup),
  "未找到兜底逻辑"
);

// ④ 深度模式行为不变（仍要求 interpret 完成）
check(
  "深度模式仍要求解读完成（行为不变）",
  /quickCloseMode\s*\?\s*!\s*slot\?\.\s*reveal\s*:\s*!\s*slot\?\.\s*reading/.test(sup),
  "深度模式分支被改动"
);

// ⑤ 快速模式必须提供 interpret_all_cards（一次讲完）
check("快速模式提供 interpret_all_cards 工具", /interpret_all_cards/.test(defs));
check(
  "快速模式的 interpret_card 被替换（模型没有单张选项）",
  /filter\(\(t\)\s*=>\s*t\.function\.name\s*!==\s*"interpret_card"\)/.test(defs)
);
check(
  "interpret_all_cards 的 required 只有数组（不暗示单张）",
  /required:\s*\["card_indexes",\s*"readings"\]/.test(defs)
);

// ⑥ 快速模式的模式定义
check("快速模式 useInvocation=false（跳过呼召三问）", /useInvocation:\s*false/.test(mode));
check("快速模式 perCardGated=false（一次讲完）", /perCardGated:\s*false/.test(mode));

console.log(`\n${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
