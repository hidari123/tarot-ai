import { readFileSync, writeFileSync } from "node:fs";

// ⚠️ 修复源码文本断言（代码搬到 features/divination 后失效）
// ⚠️ 通用修法：把"前端代码"定义为 page.tsx + features/divination/** 的合并
// ⚠️ 意图不变（"前端有没有 abort 通道" / "前端有没有播音效"…）

/** 把一个测试脚本里的 `page` 变量扩展成"前端全部代码" */
function patchFile(P, patches) {
  let s = readFileSync(P, "utf-8");
  let changed = 0;
  for (const [from, to] of patches) {
    if (s.includes(from)) {
      s = s.replace(from, to);
      changed++;
    } else {
      console.log(`  MISS in ${P}: ${from.slice(0, 70)}`);
    }
  }
  writeFileSync(P, s, "utf-8");
  console.log(`✓ ${P} (${changed}/${patches.length})`);
}

/* ---------- 通用：读取 features/divination 全部代码 ---------- */
const READ_FEATURE_CODE = `  // ⚠️ 2026-11-12 拆分：部分逻辑搬到了 src/features/divination/
  //    → 断言"前端有没有 X"时，必须把两处都算上
  const featureCode = readFileSync("src/features/divination/useStreamRunner.ts", "utf-8")
    + readFileSync("src/features/divination/useSseParser.ts", "utf-8")
    + readFileSync("src/features/divination/useDeltaBuffer.ts", "utf-8")
    + readFileSync("src/features/divination/useFlowEntries.ts", "utf-8")
    + readFileSync("src/features/divination/useDivinationState.ts", "utf-8");
  const frontCode = page + "\\n" + featureCode;`;

/* ---------- ① verify-sse-cancel ---------- */
{
  const P = "scripts/verify-sse-cancel.mjs";
  let s = readFileSync(P, "utf-8");
  // 在 const page = ... 之后插入
  const anchor = s.match(/const page = readFileSync\("src\/app\/page\.tsx", "utf-8"\);/);
  if (anchor) {
    s = s.replace(anchor[0], anchor[0] + "\n" + READ_FEATURE_CODE);
    // 把针对 page 的断言改成 frontCode
    s = s.replace(/\.test\(page\)/g, ".test(frontCode)");
    s = s.replace("const hasAbortCall = /\\.abort\\(\\)/.test(frontCode);", "const hasAbortCall = /\\.abort\\(\\)/.test(frontCode);");
    writeFileSync(P, s, "utf-8");
    console.log("✓ verify-sse-cancel");
  } else {
    console.log("MISS verify-sse-cancel anchor");
  }
}

/* ---------- ② verify-optimization-goals ---------- */
{
  const P = "scripts/verify-optimization-goals.mjs";
  let s = readFileSync(P, "utf-8");
  const anchor = s.match(/const page = readFileSync\("src\/app\/page\.tsx", "utf-8"\);/);
  if (anchor) {
    s = s.replace(anchor[0], anchor[0] + "\n" + READ_FEATURE_CODE);
    // P0-③ 那条断言用 frontCode
    s = s.replace(
      /\/new AbortController\\\(\\\)\/\.test\(page\)/,
      "/new AbortController\\\\(\\\\)/.test(frontCode)"
    );
    writeFileSync(P, s, "utf-8");
    console.log("✓ verify-optimization-goals");
  } else {
    console.log("MISS verify-optimization-goals anchor");
  }
}

/* ---------- ③ verify-ambience（音效断言） ---------- */
{
  const P = "scripts/verify-ambience.mjs";
  let s = readFileSync(P, "utf-8");
  const anchor = s.match(/const page = readFileSync\("src\/app\/page\.tsx", "utf-8"\);/);
  if (anchor) {
    s = s.replace(anchor[0], anchor[0] + "\n" + READ_FEATURE_CODE);
    // 所有针对 page 的音效断言改成 frontCode
    s = s.replace(/playSfx/.test(s) ? /(playSfx\([^)]*\))[\s\S]{0,80}?\.test\(page\)/g : /$^/, (m) => m);
    writeFileSync(P, s, "utf-8");
    console.log("✓ verify-ambience");
  } else {
    console.log("MISS verify-ambience anchor");
  }
}

/* ---------- ④ verify-ux-fixes ---------- */
{
  const P = "scripts/verify-ux-fixes.mjs";
  let s = readFileSync(P, "utf-8");
  const anchor = s.match(/const page = readFileSync\("src\/app\/page\.tsx", "utf-8"\);/);
  if (anchor) {
    s = s.replace(anchor[0], anchor[0] + "\n" + READ_FEATURE_CODE);
    writeFileSync(P, s, "utf-8");
    console.log("✓ verify-ux-fixes");
  } else {
    console.log("MISS verify-ux-fixes anchor");
  }
}

/* ---------- ⑤ verify-divination-mode ---------- */
{
  const P = "scripts/verify-divination-mode.mjs";
  let s = readFileSync(P, "utf-8");
  const anchor = s.match(/const page = readFileSync\("src\/app\/page\.tsx", "utf-8"\);/);
  if (anchor) {
    s = s.replace(anchor[0], anchor[0] + "\n" + READ_FEATURE_CODE);
    writeFileSync(P, s, "utf-8");
    console.log("✓ verify-divination-mode");
  } else {
    console.log("MISS verify-divination-mode anchor");
  }
}
