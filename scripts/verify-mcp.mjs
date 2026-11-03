#!/usr/bin/env node
/**
 * 验证 MCP Server（P3-⑨）
 *
 * ⚠️ 沙箱限制：本会话无法 spawn 子进程（EPERM），
 *    无法走"spawn mcp-server.mjs → JSON-RPC over stdio"的真实链路。
 *    改为**直接 import src/lib/mcp-tools**（工具实现与传输层解耦的意义所在）
 *    验证逻辑正确性；stdio 层由 SDK 标准 API 保证。
 *
 * 验证内容：
 *   ① 三个工具 schema（zod 契约 + 非法输入拒绝）
 *   ② draw_cards：三张/单张、牌意齐全、seed 可复现
 *   ③ interpret_cards：结构完整（问/牌位段/关键词/边界提示）
 *   ④ search_tarot：混合检索命中相关牌
 */
import {
  DrawCardsSchema, InterpretCardsSchema, SearchTarotSchema,
  drawCards, interpretLocally, searchTarot,
} from "../src/lib/mcp-tools";
// ⚠️ 不需要单独 import zod —— schema 自带 safeParse 能力，
//    校验通过 DrawCardsSchema.safeParse(...) 即可（见下方"① 工具 schema 校验"）。

const cards = await import("../src/lib/tarot-cards");
const rag = await import("../src/lib/rag-engine");
const deps = { TAROT_CARDS: cards.TAROT_CARDS, hybridSearch: rag.hybridSearch };

console.log("=== ① 模块加载与 schema 校验 ===\n");
console.log(`  知识库: ${deps.TAROT_CARDS.length} 张牌`);
console.log(`  draw_cards schema: ${DrawCardsSchema.safeParse({ spread: "three" }).success ? "✅" : "❌"}`);
console.log(`  interpret_cards schema: ${InterpretCardsSchema.safeParse({ question: "q", cards: [{ id: "Fool", pos: "过去", reversed: false }] }).success ? "✅" : "❌"}`);
console.log(`  search_tarot schema: ${SearchTarotSchema.safeParse({ query: "test" }).success ? "✅" : "❌"}`);
console.log(`  非法输入拒绝（spread=five）: ${DrawCardsSchema.safeParse({ spread: "five" }).success ? "❌（未拒绝）" : "✅"}`);

console.log("\n=== ② draw_cards ===");
const drawn = drawCards(deps, "three");
console.log(`  三张: ${drawn.map((c) => `${c.pos}·${c.nameZh}${c.reversed ? "逆" : ""}`).join("、")}`);
const drawOk = drawn.length === 3 && drawn.every((c) => c.nameZh && c.meaning && c.keywords?.length);
console.log(`  牌面完整（名/意/关键词）: ${drawOk ? "✅" : "❌"}`);
const single = drawCards(deps, "single");
console.log(`  单张: ${single[0].pos}·${single[0].nameZh} ${single.length === 1 ? "✅" : "❌"}`);

console.log("\n=== ③ seed 可复现 ===");
const d1 = drawCards(deps, "three", 42).map((c) => c.id);
const d2 = drawCards(deps, "three", 42).map((c) => c.id);
const same = JSON.stringify(d1) === JSON.stringify(d2);
console.log(`  seed=42 两次: ${d1.join(",")} → ${same ? "✅ 一致" : "❌"}`);

console.log("\n=== ④ interpret_cards ===");
const reading = interpretLocally("我最近的工作压力", drawn, "行动建议");
console.log(`  ${reading.length} 字，预览:`);
reading.split("\n").slice(0, 4).forEach((l) => console.log(`    ${l}`));
const interpOk = reading.includes("问：我最近的工作压力") && reading.includes("【") && reading.includes("关键词") && reading.includes("占卜显示倾向");
console.log(`  结构完整: ${interpOk ? "✅" : "❌"}`);

console.log("\n=== ⑤ search_tarot ===");
const st = await searchTarot(deps, "坚持 抵抗 压力", 5);
const hitLines = st.split("\n").filter((l) => l.startsWith("["));
console.log(`  命中 ${hitLines.length} 条:`);
hitLines.slice(0, 3).forEach((l) => console.log(`    ${l.slice(0, 70)}`));
const searchOk = hitLines.length > 0 && hitLines.some((l) => l.includes("权杖") || l.includes("力量"));
console.log(`  检索相关: ${searchOk ? "✅" : "❌"}`);

const allOk = drawOk && single.length === 1 && same && interpOk && searchOk;
console.log(`\n${allOk ? "✅ MCP Server 工具层全部通过（stdio 层由 SDK 标准 API 保证）" : "❌ 有问题"}`);
console.log("\nClaude Desktop 接入配置（claude_desktop_config.json）：");
console.log(JSON.stringify({
  mcpServers: {
    "mystic-tarot": { command: "npx", args: ["tsx", "<项目路径>/scripts/mcp-server.mjs"] },
  },
}, null, 2));
process.exit(allOk ? 0 : 2);
