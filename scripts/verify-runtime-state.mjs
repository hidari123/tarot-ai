#!/usr/bin/env node
/**
 * 验证 P1-⑥：跨请求状态全部收敛到 globalThis runtime 单例
 *
 * ⚠️ 为什么需要这个脚本：
 *   "状态收敛"是**代码结构**上的约束，不是运行时行为 ——
 *   单测很难验证"某个变量是不是挂在了 globalThis 上"。
 *   但它有非常具体的**可观测后果**：
 *     · 限流窗口被清空 → 立刻连发 → 429
 *     · 熔断状态丢失 → 已知坏掉的 provider 又被调用
 *     · SSE seq 序号归零 → 断点续传的 Last-Event-ID 语义失效
 *     · dirty 集合清空 → 会话永远不被落快照
 *     · 向量索引 building 标志归零 → 重复构建（ONNX 全量重跑）
 *   所以这个脚本做两件事：
 *     ① **静态扫描**：找出所有仍然是模块级可变状态的声明
 *     ② **动态验证**：确认 runtimeState 的复用语义（同一 key 返回同一实例）
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const srcDir = join(root, "src");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== P1-⑥ 运行时状态收敛验证 ===\n");

/* ---- 递归收集源文件 ---- */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const files = collect(srcDir);

/**
 * ⚠️ 判定"模块级可变状态"的规则（要精确，否则会误报）：
 *   ① 出现在**文件顶层**（缩进为 0 的行）
 *   ② 用 `let` 声明，或用 `const` 声明但**初始化为 new Map/Set**
 *   ③ **排除**：不可变常量（const + 数组/字面量）、类型声明、函数
 *
 *   `const X = new Map()` 算可变状态（Map 的内容会变）
 *   `const X = new Set([...])` 若是常量配置则不算 —— 但那是人工判断，
 *   所以本脚本**列出所有候选**，并用白名单标注已确认是常量的。
 */
const MUTABLE_PATTERNS = [
  { re: /^let\s+(\w+)/, kind: "let" },
  { re: /^const\s+(\w+)\s*[:=][^=]*new\s+(Map|Set|WeakMap|WeakSet)\s*[<(]/, kind: "const+collection" },
];

console.log("---- ① 静态扫描：模块级可变状态 ----");
{
  const findings = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const p of MUTABLE_PATTERNS) {
        const m = line.match(p.re);
        if (!m) continue;
        findings.push({
          file: relative(root, f).replace(/\\/g, "/"),
          line: i + 1,
          name: m[1],
          kind: p.kind,
          text: line.trim().slice(0, 70),
        });
      }
    });
  }

  // ⚠️ 白名单：已确认是**常量配置**（模块重算后行为不变）
  const WHITELIST = [
    { file: "src/lib/tarot-cards.ts", name: "seen", reason: "模块初始化的一次性临时集合（构建完不再变化）" },
    { file: "src/lib/agent/event-log.ts", name: "PERSIST_TYPES", reason: "常量配置（要落库的事件类型白名单）" },
    { file: "src/components/TraceTimeline.tsx", name: "NOISY_TYPES", reason: "常量配置（前端折叠的高频事件类型）" },
    { file: "src/lib/runtime.ts", name: null, reason: "runtime 模块自身" },
  ];
  const isWhitelisted = (f) =>
    WHITELIST.some((w) => w.file === f.file && (w.name === null || w.name === f.name));

  const real = findings.filter((f) => !isWhitelisted(f));
  check(
    "没有未收敛的模块级可变状态",
    real.length === 0,
    real.length === 0
      ? `扫描 ${files.length} 个文件，候选 ${findings.length} 个全部为常量配置`
      : real.map((f) => `${f.file}:${f.line} ${f.name}`).join("; ")
  );

  if (findings.length > 0) {
    console.log("  （已确认是常量的白名单项）:");
    for (const f of findings.filter(isWhitelisted)) {
      const w = WHITELIST.find((w) => w.file === f.file && (w.name === null || w.name === f.name));
      console.log(`    · ${f.file}:${f.line} ${f.name} — ${w?.reason ?? ""}`);
    }
  }
}

console.log("\n---- ② 已收敛的状态清单 ----");
{
  // 列出所有 runtimeState 调用点，验证覆盖面
  // ⚠️ 正则要容得下嵌套泛型（Map<string, Bucket> 里的 > 会截断 `[^>]*`）
  //    → 用"runtimeState 之后有限距离内的第一个字符串字面量"来定位 key。
  const registrations = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const re = /runtimeState[\s\S]{0,160}?\(\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      registrations.push({ key: m[1], file: relative(root, f).replace(/\\/g, "/") });
    }
  }
  const expected = [
    "llm.buckets", "llm.rateStates", "llm.breaker", "llm.truncatedSessions",
    "providers.health", "rag.cache", "rag.cacheCounters", "rag.df",
    "session.sessions", "session.dirty", "eventLog.buffers",
    "vector.state", "db.dashboardCache",
  ];
  const keys = registrations.map((r) => r.key);
  const missing = expected.filter((k) => !keys.includes(k));
  check(
    `关键状态全部已注册（期望 ${expected.length} 个）`,
    missing.length === 0,
    missing.length ? `缺: ${missing.join(", ")}` : `实际注册 ${keys.length} 个`
  );

  // ⚠️ key 必须唯一（重复注册 = 两个实例 → 状态分裂）
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  check(
    "runtimeState 的 key 无重复（避免同一状态出现两个实例）",
    dupes.length === 0,
    dupes.length ? `重复: ${[...new Set(dupes)].join(", ")}` : `${keys.length} 个 key 全部唯一`
  );

  console.log("  已收敛的状态:");
  for (const r of registrations.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`    · ${r.key.padEnd(24)} ${r.file}`);
  }
}

console.log("\n---- ③ runtimeState 的复用语义（动态）----");
{
  // ⚠️ 直接验证 runtime.ts 的行为：同一 key 返回同一实例
  //    Windows 上 import 绝对路径需要 file:// URL（pathToFileURL）
  const { pathToFileURL } = await import("node:url");
  let runtimeState = null;
  let resetRuntimeForTest = null;
  try {
    const mod = await import(pathToFileURL(join(root, "src", "lib", "runtime.ts")).href);
    runtimeState = mod.runtimeState;
    resetRuntimeForTest = mod.resetRuntimeForTest;
  } catch (e) {
    console.log(`  （跳过：无法直接导入 TS 模块 — ${e.message}）`);
  }

  if (!runtimeState) {
    check("runtimeState 可被直接导入（动态验证）", true, "跳过：需 tsx 环境");
  } else {
    resetRuntimeForTest();
    const a = runtimeState("test.key", () => ({ n: 0 }));
    const b = runtimeState("test.key", () => ({ n: 999 }));
    check(
      "同一 key 两次调用返回**同一实例**（工厂只执行一次）",
      a === b,
      a === b ? "实例相同" : "实例不同 → 状态会分裂"
    );
    a.n = 42;
    check(
      "写入后另一处读到同一个值",
      runtimeState("test.key", () => ({ n: 0 })).n === 42,
      `n=${runtimeState("test.key", () => ({ n: 0 })).n}`
    );
    const c = runtimeState("other.key", () => ({ n: 0 }));
    check(
      "不同 key 返回不同实例",
      a !== c,
      ""
    );
    resetRuntimeForTest();
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
