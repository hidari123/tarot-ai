/**
 * 检索质量自检（无需起 server）
 * 用例：
 *   1. 牌名精确查询："宝剑十" → 应置顶宝剑十，不再被权杖十/星币十污染
 *   2. 多牌合并查询："权杖六 圣杯七" → 两张牌都应命中
 *   3. 语义查询："事业 转变" → 不要求精确，看语义通道
 *
 * 运行：node scripts/test-rag-quality.cjs
 */
const { execSync } = require("child_process");
const path = require("path");

// 用 next 内置的 TS 转译跑（避免额外装 tsx）——直接调 Node 的 --experimental-strip-types?
// 简化：这里内联一份与 rag-engine.ts 相同逻辑的纯 JS 验证（同步维护点已在文件头注明）

// 直接复用 mcp-server 的纯 JS 版本（与 src/lib 同步，包含精确通道）
const { ragSearch, extractMentionedCards } = require("../mcp-server/rag-engine.cjs");

let fail = 0;
function check(name, cond, detail) {
  const mark = cond ? "✓" : "✗";
  if (!cond) fail++;
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("== 1. 牌名精确查询「宝剑十」 ==");
const r1 = ragSearch("宝剑十", 5);
check("返回非空", r1.length > 0, `${r1.length} 条`);
check("top1 = 宝剑十", r1[0]?.cardNameZh === "宝剑十", `top1=${r1[0]?.cardNameZh}(${r1[0]?.channels?.join("+")})`);
const bad = r1.filter((h) => h.cardNameZh !== "宝剑十" && /十$/.test(h.cardNameZh));
check("无关「X十」牌未挤进前列", bad.length <= 1, bad.length ? `混入: ${bad.map((h) => h.cardNameZh).join(",")}` : "无");
check("宝剑十带 exact 通道标记", r1.slice(0, 3).some((h) => h.channels?.includes("exact")));

console.log("\n== 2. 多牌合并查询「权杖六 圣杯七」 ==");
const r2 = ragSearch("权杖六 圣杯七", 8);
check("两张牌都在结果里", r2.some((h) => h.cardNameZh === "权杖六") && r2.some((h) => h.cardNameZh === "圣杯七"),
  r2.slice(0, 5).map((h) => h.cardNameZh).join("、"));

console.log("\n== 3. 语义查询「事业上的转变」 ==");
const r3 = ragSearch("事业上的转变", 5);
check("返回非空", r3.length > 0, r3.slice(0, 3).map((h) => `${h.cardNameZh}`).join("、"));

console.log("\n== 4. extractMentionedCards ==");
check("「宝剑十」→ 抽到牌", extractMentionedCards("我想问宝剑十的含义").length === 1);
check("无牌名 → 空", extractMentionedCards("最近工作怎么样").length === 0);

console.log(fail === 0 ? "\n✅ 全部通过" : `\n❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
