#!/usr/bin/env node
/**
 * 批量修复脚本：SSE 单行解析 → 按行拆（支持 `id:` 字段的多行帧）
 *
 * ⚠️ 背景（P1-③D 引入 SSE `id:` 字段后的副作用）：
 *    后端现在发的是多行帧：
 *      id: 5
 *      data: {...}
 *    旧解析 `p.trim().startsWith("data:")` 会**整帧跳过** ——
 *    所有验证脚本收不到任何事件（看起来像"功能全坏了"）。
 *
 *    修法：按行拆帧，找 data: 行（与前端 page.tsx 一致）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "scripts");

/** 待修的脚本（单行解析模式） */
const TARGETS = [
  "verify-flip-gate.mjs",
  "verify-flip-race.mjs",
  "verify-antispoil.mjs",
  "verify-teller-voice.mjs",
  "verify-persona-suggest.mjs",
  "verify-plan-mode.mjs",
  "verify-session-snapshot.mjs",
  "debug-sse.mjs",
  "debug-ask.mjs",
  "debug-ask.cjs",
  "debug-ritual.mjs",
];

/** 模式 A：const line = p.trim(); + if (!line.startsWith("data:")) continue; */
const PATTERN_A = /const line = p\.trim\(\);\r?\n(\s*)if \(!line\.startsWith\("data:"\)\) continue;/g;

/** 模式 B：if (!line.startsWith("data:")) continue; 紧跟 JSON.parse(line.slice(5).trim()) */
const PATTERN_B = /if \(!line\.startsWith\("data:"\)\) continue;\r?\n(\s*)(let evt;|const evt =|try \{ evt =)?/g;

let fixed = 0;
for (const name of TARGETS) {
  const path = join(SCRIPTS, name);
  let src;
  try { src = readFileSync(path, "utf-8"); } catch { continue; }
  if (!src.includes('startsWith("data:")')) continue;

  const orig = src;

  // 模式 A 替换
  src = src.replace(
    PATTERN_A,
    (m, indent) =>
      `// ⚠️ SSE 帧可能是多行（id: <seq> + data: <json>）—— 按行拆找 data: 行\n` +
      `${indent}let dataLine = "";\n` +
      `${indent}for (const raw of p.split("\\n")) {\n` +
      `${indent}  const l = raw.trim();\n` +
      `${indent}  if (l.startsWith("data:")) { dataLine = l.slice(5).trim(); break; }\n` +
      `${indent}}\n` +
      `${indent}if (!dataLine) continue;`
  );

  // 替换后续的 line.slice(5).trim() → dataLine
  src = src.replace(/line\.slice\(5\)\.trim\(\)/g, "dataLine");

  if (src !== orig) {
    writeFileSync(path, src, "utf-8");
    fixed++;
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  – ${name}（无匹配，跳过）`);
  }
}
console.log(`\n已修复 ${fixed}/${TARGETS.length} 个脚本`);
