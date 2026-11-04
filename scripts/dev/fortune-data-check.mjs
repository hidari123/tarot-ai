#!/usr/bin/env node
/**
 * 诊断：核实运势内容（C 方向）能不能靠静态数据做出来
 *
 * ⚠️ 关键问题：年运/流年/四季这类内容需要"牌阵 + 大量文案"，
 *   能不能**零 LLM 成本**做出来？答案取决于牌库里的字段够不够。
 *
 * ⚠️ 用法：npx tsx scripts/dev/fortune-data-check.mjs
 */
import { readFileSync } from "node:fs";

const raw = JSON.parse(readFileSync("src/data/tarot-lab-cards.json", "utf-8"));

console.log("=== 牌库原始字段 ===");
console.log(Object.keys(raw[0]).join(", "));

console.log("\n=== 各字段的可用性 ===");
const fields = ["name", "description", "normal", "reversed", "detail", "link"];
for (const f of fields) {
  const vals = raw.map((c) => c[f]);
  const nonEmpty = vals.filter((v) => typeof v === "string" && v.trim().length > 0).length;
  const lens = vals.filter((v) => typeof v === "string").map((v) => v.length);
  const avg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
  const max = lens.length ? Math.max(...lens) : 0;
  console.log(
    `${f.padEnd(12)} 非空 ${String(nonEmpty).padStart(3)}/${raw.length} · 平均 ${String(avg).padStart(4)} 字 · 最长 ${String(max).padStart(5)} 字`
  );
}

console.log("\n=== 样例（判断能否改写成运势文案）===");
const s = raw[0];
console.log("name:", s.name);
console.log("description:", String(s.description).slice(0, 160));
console.log("normal:", String(s.normal).slice(0, 160));
console.log("reversed:", String(s.reversed).slice(0, 160));
console.log("detail:", String(s.detail || "").slice(0, 200));

console.log("\n=== 全库总字数（运势矩阵的文案原料）===");
const totalDesc = raw.reduce((n, c) => n + String(c.description || "").length, 0);
const totalNormal = raw.reduce((n, c) => n + String(c.normal || "").length, 0);
const totalReversed = raw.reduce((n, c) => n + String(c.reversed || "").length, 0);
console.log(`牌面故事 ${totalDesc} 字 · 正位牌意 ${totalNormal} 字 · 逆位牌意 ${totalReversed} 字`);
console.log(`合计 ${totalDesc + totalNormal + totalReversed} 字（≈ 足够生成完整年运文本）`);

console.log("\n=== 关键词可提取性（用于运势主题词）===");
let kwTotal = 0;
for (const c of raw.slice(0, 5)) {
  const kws = String(c.normal || "")
    .split(/[，,、]/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 8);
  console.log(`  ${c.name}: ${kws.slice(0, 6).join(" / ")}`);
  kwTotal += kws.length;
}
console.log(`（5 张牌共提取 ${kwTotal} 个候选关键词）`);
