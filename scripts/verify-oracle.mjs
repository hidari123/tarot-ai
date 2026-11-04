#!/usr/bin/env node
/**
 * 验证：问神谕（Oracle）—— 免抽牌的对话式塔罗向导（2026-11-04 D 方向）
 *
 * ⚠️ 为什么需要这份脚本：
 *   神谕是**能力层**的差异（工具集不同），最危险的回归是：
 *     · 抽牌工具又出现在神谕的工具集里（"免抽牌"语义被破坏）
 *     · 神谕的纯文本回答被"首答纠偏"拦下（要求它去抽牌）→ 死循环
 *     · 神谕会话的仪式阶段被反推成 contract → 触发承约守卫 → 卡死
 *     · 客户端把追问发到 interpret 而非 answer → 新建会话 → 上下文丢失
 *
 * 用法：npx tsx scripts/verify-oracle.mjs
 */

import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

console.log("=== 问神谕（Oracle）验证 ===\n");

/* ────────────── ① 工具集（能力层禁用） ────────────── */
console.log("【① 工具集】（免抽牌 = 能力层禁用，不是 prompt 建议）");
{
  const defs = readFileSync("src/lib/agent/tools/definitions.ts", "utf-8");
  const code = strip(defs);

  check("定义了 ORACLE_TOOLS", /export const ORACLE_TOOLS/.test(code));
  check("神谕保留 rag_search（查典籍是核心能力）",
    /ORACLE_TOOLS = TOOLS\.filter[\s\S]{0,200}"rag_search"/.test(code));
  check("神谕保留 ask_user（对话需要澄清）",
    /ORACLE_TOOLS = TOOLS\.filter[\s\S]{0,200}"ask_user"/.test(code));

  // ⚠️ 关键：抽牌类与岔路类工具必须**不在**神谕工具集里
  const oracleBlock = code.match(/export const ORACLE_TOOLS[\s\S]*?;/)?.[0] ?? "";
  for (const t of ["draw_cards", "offer_card_selection", "reveal_card", "interpret_card", "write_reading", "establish_contract", "invoke_three_questions", "fate_crossroads"]) {
    check(`神谕工具集不含 ${t}`, !oracleBlock.includes(`"${t}"`));
  }
}

/* ────────────── ② 引擎接线 ────────────── */
console.log("\n【② 引擎接线】（共用 runAgent，只换外壳）");
{
  const sup = readFileSync("src/lib/agent/supervisor.ts", "utf-8");
  const code = strip(sup);

  check("supervisor 识别神谕（session.kind）", /session\.kind === "oracle"/.test(code));
  check("神谕用 ORACLE_TOOLS", /oracleMode\s*\?\s*ORACLE_TOOLS/.test(code));
  check("神谕有独立的轮次上限（更少轮次）",
    /oracleMode\s*\?\s*8/.test(code) || /const MAX_ROUNDS = oracleMode/.test(code));

  // ⚠️ 关键：神谕的纯文本回答必须直接结束（不能走"首答纠偏"）
  check("神谕纯文本回答直接结束（不走首答纠偏）",
    /if \(oracleMode\) \{[\s\S]{0,300}yield \{ type: "done" \}/.test(code));
  check("首答纠偏在神谕之前被短路",
    code.indexOf("if (oracleMode)") < code.indexOf("noToolRetries++"));

  check("神谕不做 Plan-Execute（没有仪轨）",
    /agentMode === "plan" && !oracleMode/.test(code));
  check("神谕不走本地占卜降级剧本",
    /!oracleMode && !isFollowup/.test(code));
  check("神谕开场白不是「我想占卜」",
    /oracleMode \? question : `我想占卜/.test(code));

  const helpers = readFileSync("src/lib/agent/helpers.ts", "utf-8");
  check("神谕用独立的 system prompt", /buildOraclePrompt/.test(helpers));
  const prompts = readFileSync("src/lib/prompts.ts", "utf-8");
  const pcode = strip(prompts);
  check("神谕 prompt 存在（buildOraclePrompt）", /export function buildOraclePrompt/.test(pcode));
  check("神谕 prompt 要求检索后再谈牌义", /必须.*rag_search.*检索/.test(pcode));
  check("神谕 prompt 有长度约束（避免长篇报告）",
    /150~300 字/.test(pcode) || /150~300字/.test(pcode));
  check("神谕 prompt 禁止替用户做选择", /不要替用户做选择/.test(pcode));
}

/* ────────────── ③ 会话与 API ────────────── */
console.log("\n【③ 会话与 API】");
{
  const sess = readFileSync("src/lib/agent/session.ts", "utf-8");
  const code = strip(sess);

  check("createSession 接受 kind 参数", /kind: SessionKind = DEFAULT_KIND/.test(code));
  check("神谕会话的仪式阶段恒为 done（不走仪式）",
    /ritualPhase: kind === "oracle" \? "done" : "contract"/.test(code));
  check("快照含 kind", /kind: s\.kind/.test(code));
  check("恢复时按 kind 处理仪式阶段（神谕不反推）",
    /snap\.kind === "oracle"\s*\?\s*"done"/.test(code));

  const route = readFileSync("src/app/api/interpret/route.ts", "utf-8");
  check("API 接受 kind", /kind\?: string/.test(route));
  check("API 用 resolveKind 宽容解析", /resolveKind\(body\.kind\)/.test(route));

  const kindMod = readFileSync("src/lib/agent/session-kind.ts", "utf-8");
  const kcode = strip(kindMod);
  check("有 SessionKind 类型", /export type SessionKind = "divination" \| "oracle"/.test(kcode));
  check("有 resolveKind（非法值退回默认）", /export function resolveKind/.test(kcode));
  check("默认是 divination", /DEFAULT_KIND: SessionKind = "divination"/.test(kcode));
}

/* ────────────── ④ 前端 ────────────── */
console.log("\n【④ 前端】");
{
  check("神谕页面存在", existsSync("src/app/oracle/page.tsx"));
  check("神谕组件存在", existsSync("src/components/OracleChat.tsx"));

  const chat = readFileSync("src/components/OracleChat.tsx", "utf-8");
  const code = strip(chat);

  check("神谕页有 SEO metadata",
    /export const metadata/.test(readFileSync("src/app/oracle/page.tsx", "utf-8")));
  check("追问走 answer 端点（不是重新发 interpret）",
    /fetch\("\/api\/answer"/.test(code));
  check("首问带 kind: oracle", /kind: "oracle"/.test(code));
  check("追问用 followup + sessionId", /followup: q/.test(code));
  check("done 事件会 flush 并结束 busy",
    /case "done":[\s\S]{0,120}flush\(\);[\s\S]{0,80}setBusy\(false\)/.test(code));
  check("有典籍面板（引文溯源）", /KnowledgePanel/.test(code));

  // ⚠️ 注释里不能出现 `**/` —— 那会提前闭合块注释（实测踩坑）
  const rawChat = readFileSync("src/components/OracleChat.tsx", "utf-8");
  check("注释里没有 `**/`（会提前闭合块注释 → 构建失败）", !/\*\*/.test(rawChat) || !/\*\*\//.test(rawChat));
}

/* ────────────── ⑤ 端到端脚本 ────────────── */
console.log("\n【⑤ 端到端脚本】");
{
  check("端到端脚本存在", existsSync("scripts/dev/e2e-oracle.mjs"));
  const e2e = readFileSync("scripts/dev/e2e-oracle.mjs", "utf-8");
  check("e2e 断言不调用抽牌类工具", /DRAW_TOOLS/.test(e2e));
  check("e2e 断言回答长度克制", /1200/.test(e2e));
  check("e2e 测追问", /followup/.test(e2e));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
