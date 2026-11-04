#!/usr/bin/env node
/**
 * 验证：SVG 图标集（2026-11-04 用户诉求："目前图标都是emoji，想要更漂亮一点的图标"）
 *
 * ⚠️ 为什么 emoji 要被替换（写进注释，防改回去）：
 *   ① **跨平台不一致**：同一个 🃏 在 Windows 是 Segoe UI Emoji（方块脸）、
 *      macOS 是 Apple Color Emoji、Android 是 Noto Color Emoji —— 三种长相。
 *      Linux 服务器上更可能渲染成**豆腐块**（□）。
 *   ② **与调性不搭**：emoji 是圆润的彩色贴纸风，
 *      本项目是"暗紫 + 金线 + 魔法阵"的古典神秘风。
 *   ③ **不可控**：大小/基线/颜色随系统字体变化。
 *   → SVG：任何设备完全一致 + 继承 currentColor + 与紫金配色统一。
 *
 * 用法：node scripts/verify-icons.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== SVG 图标集验证 ===\n");

const icons = readFileSync("src/components/icons.tsx", "utf-8");

/* ────────────── ① 图标集本身 ────────────── */
console.log("【① 图标集结构】");
{
  check("图标组件存在", /export default function Icon/.test(icons));
  check("导出了 IconName 类型", /export type IconName/.test(icons));
  check("用 currentColor（继承调用方颜色）", /stroke="currentColor"/.test(icons));
  check("viewBox 统一 24×24", /viewBox="0 0 24 24"/.test(icons));
  check("全部用 fill=none（线条图标）", /fill="none"/.test(icons));
  check("圆角端点（柔和，契合神秘调性）", /strokeLinecap="round"/.test(icons));
  check("aria-hidden（装饰性图标不干扰读屏）", /aria-hidden="true"/.test(icons));

  // ⚠️ 图标名必须在 IconName 联合类型里
  const names = [...icons.matchAll(/^\s{2}(\w+):\s*\(/gm)].map((m) => m[1]);
  check("至少 12 个图标", names.length >= 12, `${names.length} 个`);
  const typeBlock = icons.match(/export type IconName =([\s\S]*?);/);
  check("有 IconName 联合类型", !!typeBlock);
  if (typeBlock) {
    const declared = [...typeBlock[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    const missing = names.filter((n) => !declared.includes(n));
    check("每个图标都在 IconName 里声明（类型保证有效）", missing.length === 0,
      missing.length ? `缺: ${missing.join(", ")}` : `${declared.length} 个名字`);
    const orphan = declared.filter((d) => !names.includes(d) && d !== "IconName");
    check("没有「声明了但没实现」的图标名", orphan.length === 0,
      orphan.length ? `孤立: ${orphan.join(", ")}` : "");
  }
}

/* ────────────── ② 使用处：emoji 已清零 ────────────── */
console.log("\n【② 主界面 emoji 清零】");
{
  /** 递归收集 tsx 文件 */
  const walk = (dir) => {
    const out = [];
    for (const f of readdirSync(dir)) {
      const p = `${dir}/${f}`;
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (p.endsWith(".tsx")) out.push(p);
    }
    return out;
  };
  const files = walk("src");
  /**
   * ⚠️ emoji 码位范围（**只查真正的 emoji**，不含几何/装饰符号）
   *
   * ⚠️ 踩过一次坑：最初把 U+2700–U+27BF（ dingbats ）也算进去，
   *   结果把项目合法使用的 `✓ ◉ ✗` 状态标记也判成 emoji。
   *   → 那些是**几何/文字符号**（不是 emoji），跨平台也一致，可以留。
   *
   * 真正要禁的是：
   *   U+1F300–U+1FAFF（表情与象形符号）
   *   U+1F900–U+1F9FF（补充符号）
   *   U+2600–U+26FF（杂项符号：☀ ☂ ☃ 等图形字符）
   *   U+FE0F（emoji 变体选择符）
   */
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{FE0F}]/u;

  let bad = [];
  for (const f of files) {
    const src = readFileSync(f, "utf-8");
    // ⚠️ 剥离注释后再查（注释里可以提 emoji 作为反例）
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const lines = code.split("\n");
    lines.forEach((line, i) => {
      if (EMOJI.test(line)) {
        bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 70)}`);
      }
    });
  }
  check("src/ 下无 emoji（可渲染代码）", bad.length === 0,
    bad.length ? `${bad.length} 处残留:\n      ` + bad.slice(0, 5).join("\n      ") : "全部已换成 SVG");

  // ⚠️ 图标组件内的 emoji 只允许出现在**注释**里（那里是反例说明）
  const iconsCode = icons
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  check("图标组件的可渲染代码内无 emoji", !EMOJI.test(iconsCode));
}

/* ────────────── ③ 关键界面确实用了图标 ────────────── */
console.log("\n【③ 关键界面已接入图标】");
{
  const page = readFileSync("src/app/page.tsx", "utf-8");
  const flow = readFileSync("src/components/DialogueFlow.tsx", "utf-8");
  const dash = readFileSync("src/app/dashboard/page.tsx", "utf-8");
  const review = readFileSync("src/components/ReviewCard.tsx", "utf-8");
  const pipeline = readFileSync("src/components/SubAgentPipeline.tsx", "utf-8");
  const trace = readFileSync("src/components/AgentTrace.tsx", "utf-8");

  check("主页 import 了图标组件", /from "@\/components\/icons"/.test(page));
  check("主页的阶段图标用了 Icon", /<Icon name=\{PHASE_TEXT/.test(page));
  check("对话流用了 Icon", /<Icon name=/.test(flow));
  check("观测面板用了 Icon", /<Icon name=/.test(dash));
  check("审校卡用了 Icon", /<Icon name=\{d\.icon\}/.test(review));
  check("子 Agent 管线用了 Icon", /<Icon name=\{meta\.icon\}/.test(pipeline));
  check("工具追踪用了 Icon", /<Icon name=\{meta\.icon\}/.test(trace));

  // ⚠️ 图标名必须是有效的 IconName（编译期已保证，这里抽查常见错误）
  check("没有把 emoji 当图标名传入", !/<Icon name="[^a-z]/i.test(page + flow + dash));
}

/* ────────────── ④ 交互反馈（翻牌可点性，第 3/5 条） ────────────── */
console.log("\n【④ 翻牌面板展开/收起逻辑】");
{
  const flow = readFileSync("src/components/DialogueFlow.tsx", "utf-8");
  check("有「牌上有待答问题」的判据", /hasPendingCardQuestion/.test(flow));
  check("有待答问题时展开（用户必须看到问题）",
    /wantOpen = hasPendingCardQuestion \|\|/.test(flow));
  check("FlowSpreadCard 有 question 字段", /question\?: string/.test(flow));
  check("FlowSpreadCard 有 answer 字段", /answer\?: string/.test(flow));

  const page = readFileSync("src/app/page.tsx", "utf-8");
  check("提问时同步 question 到牌阵条目", /question: q/.test(page));
  check("回答时同步 answer 回牌阵条目", /c\.question && !c\.answer \? \{ \.\.\.c, answer \}/.test(page));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
