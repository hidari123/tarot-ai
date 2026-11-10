#!/usr/bin/env node
/**
 * 构建后：给 Service Worker 注入版本号（2026-11-09）
 *
 * ⚠️⚠️ 为什么需要这个脚本（用户反馈「前端页面怎么变成早期版本的了」）：
 *   `public/sw.js` 里 `const CACHE_VERSION = "v1"` **从项目开始就没变过**。
 *   → 每次构建后，SW 的静态缓存名字都一样
 *   → activate 阶段的"清旧缓存"逻辑判断 `k !== STATIC_CACHE` 就全部保留
 *   → 旧 chunk 永远留在缓存里。
 *
 *   叠加 SW 的 **stale-while-revalidate** 策略（先给缓存、后台再更新）：
 *   → 页面 HTML 是新的（导航走 network-first）
 *   → 但站内跳转的页面请求走了缓存分支 → **返回旧 HTML**
 *   → 表现：**看起来像早期版本**
 *
 * ⚠️ 修法（三个一起）：
 *   ① **版本号随构建变** → 每次构建 = 新缓存名 → activate 时旧缓存全清
 *   ② **sw.js 文件名带版本号**（sw.v<hash>.js）→ URL 变了 → 浏览器强制更新 SW
 *      （`public/` 下的文件不参与 Next.js 内容哈希 → URL 永远不变 → SW 不会更新）
 *   ③ **清理旧版本文件** → public/ 不越积越多
 *
 * 用法：node scripts/dev/bump-sw-version.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SRC = "src/sw/sw.js";
const OUT_DIR = "public";
const REGISTER = "src/components/PwaRegister.tsx";
const PLACEHOLDER = "__CACHE_VERSION__";

if (!existsSync(SRC)) {
  console.error(`✗ 找不到 ${SRC}`);
  process.exit(1);
}

// ① 版本号：优先用 git 的最新提交号（可追溯），没有则用时间戳
let version;
try {
  version = execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: "pipe" })
    .toString()
    .trim();
} catch {
  version = "";
}
if (!version) version = Date.now().toString(36);

const content = readFileSync(SRC, "utf-8").replace(PLACEHOLDER, version);

mkdirSync(OUT_DIR, { recursive: true });

// ② 写出带版本号的 SW（URL 变了 → 浏览器强制更新）
const swFile = `sw.v${version}.js`;
writeFileSync(join(OUT_DIR, swFile), content, "utf-8");

// ③ 同步 /sw.js（老客户端仍在请求它）
writeFileSync(join(OUT_DIR, "sw.js"), content, "utf-8");

// ④ 清理旧的版本化 SW 文件
let cleaned = 0;
for (const f of readdirSync(OUT_DIR)) {
  if (/^sw\.v[^.]+\.js$/.test(f) && f !== swFile) {
    try {
      unlinkSync(join(OUT_DIR, f));
      cleaned++;
    } catch {
      /* ignore */
    }
  }
}

// ⑤ 更新 PwaRegister 的注册路径 → 指向带版本号的新文件
if (existsSync(REGISTER)) {
  let reg = readFileSync(REGISTER, "utf-8");
  const before = reg;
  reg = reg.replace(/\.register\("\/sw[^"]*\.js",/, `.register("/${swFile}",`);
  if (reg !== before) {
    writeFileSync(REGISTER, reg, "utf-8");
    console.log(`✓ PwaRegister 注册路径 → /${swFile}`);
  }
}

console.log(`✓ SW 版本号 → ${version}`);
console.log(`✓ 生成 public/${swFile}`);
console.log(`✓ public/sw.js 同步更新`);
if (cleaned > 0) console.log(`✓ 清理 ${cleaned} 个旧版本 SW 文件`);
