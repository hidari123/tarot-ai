import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * ⚠️ 扫描 public/ 下的所有资源，找出**没有被引用**的
 */

/** 源码目录 */
const SRC_DIRS = ["src", "scripts", "docs"];
/** 收集所有源码文本 */
const texts = [];
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", ".git"].includes(e.name)) continue;
      walk(p);
    } else {
      if ([".ts", ".tsx", ".js", ".mjs", ".jsx", ".css", ".md", ".json", ".html"].includes(extname(e.name))) {
        texts.push(readFileSync(p, "utf8"));
      }
    }
  }
}
for (const d of SRC_DIRS) if (existsSync(d)) walk(d);
const ALL = texts.join("\n");

/** 扫描 public/ */
function scanPublic(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = prefix + e.name;
    if (e.isDirectory()) out.push(...scanPublic(p, rel + "/"));
    else out.push({ rel, path: p, size: statSync(p).size });
  }
  return out;
}

const files = scanPublic("public");

/** 未引用 */
const unused = [];
for (const f of files) {
  // 用文件名（不含扩展名）搜索 —— 路径可能拼在不同地方
  const base = f.rel.replace(/\.[^.]+$/, "");
  const nameOnly = base.split("/").pop();
  const hits =
    ALL.includes(f.rel) ||
    ALL.includes(base) ||
    ALL.includes(`/${nameOnly}`) ||
    ALL.includes(nameOnly);
  if (!hits) unused.push(f);
}

console.log("=== 未被引用的资源 ===");
let total = 0;
for (const u of unused.sort((a, b) => b.size - a.size)) {
  console.log(`  ${u.rel.padEnd(46)} ${(u.size / 1024).toFixed(1)} KB`);
  total += u.size;
}
console.log(`\n合计 ${unused.length} 个，${(total / 1024).toFixed(0)} KB`);

console.log("\n=== 全部资源引用情况 ===");
for (const f of files.filter((f) => !f.rel.startsWith("cards/"))) {
  const nameOnly = f.rel.replace(/\.[^.]+$/, "").split("/").pop();
  const hits = ALL.includes(f.rel) || ALL.includes(nameOnly);
  console.log(`  ${hits ? "✓" : "✗"} ${f.rel}`);
}
