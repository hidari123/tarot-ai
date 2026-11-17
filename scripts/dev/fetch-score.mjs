#!/usr/bin/env node
/**
 * 下载 AI 生成的配乐到 `public/audio/`
 *
 * ⚠️ 为什么需要这个脚本：
 *   AI 生成的音频存在 Matrix Drive 上（node_id），`public/audio/` 里的是**拷贝**。
 *   万一本地文件丢了、或想换一批重新生成，这个脚本能按 `score-sources.json`
 *   的登记表把文件补齐 —— 不需要重新烧一次生成额度。
 *
 * ⚠️ 为什么不用 npm 脚本：
 *   这是一次性的运维动作，不属于 `npm run verify` 的常规门禁。
 *
 * 用法：
 *   node scripts/dev/fetch-score.mjs            # 补齐缺失的文件
 *   node scripts/dev/fetch-score.mjs --force    # 全部重新下载
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const srcFile = join(here, "score-sources.json");
const outDir = join(root, "public", "audio");
const force = process.argv.includes("--force");

/**
 * 从 mcode-tools 的输出里抠出 JSON
 *
 * ⚠️ 为什么不能直接 JSON.parse(stdout)：
 *   mcode-tools 会往 stderr 打 UNDICI 实验性警告、npm 也会打提示行，
 *   stdout 里可能混入非 JSON 的行 → 用首个 `{` 到末个 `}` 截取最稳。
 */
function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`输出里没有 JSON：\n${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start, end + 1));
}

const manifest = JSON.parse(readFileSync(srcFile, "utf8"));
const tracks = manifest.tracks ?? [];

mkdirSync(outDir, { recursive: true });

let ok = 0;
let skipped = 0;
let failed = 0;

for (const t of tracks) {
  const out = join(outDir, t.file_name);
  if (!force && existsSync(out) && statSync(out).size > 1024) {
    console.log(`· ${t.file_name} 已存在（${(statSync(out).size / 1024).toFixed(0)}KB）跳过`);
    skipped++;
    continue;
  }

  try {
    const res = spawnSync("mcode-tools", ["get_asset_url", t.node_id], {
      encoding: "utf8",
      shell: true,
    });
    /**
     * ⚠️ 为什么不用退出码判断成败：
     *   mcode-tools 会往 stderr 打 UNDICI 实验性警告，
     *   经由 PowerShell + shell:true 转发时可能被算成非零退出码
     *   → 但 stdout 里其实有**完全正常**的 JSON。
     *   → 所以判据是「能不能解析出 download_url」，不是退出码。
     */
    const json = extractJson(res.stdout || "");
    const url = json.download_url;
    if (!url) throw new Error("返回里没有 download_url");

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1024) throw new Error(`文件太小（${buf.length}B），疑似下载失败`);
    writeFileSync(out, buf);

    console.log(`✓ ${t.file_name}（${(buf.length / 1024).toFixed(0)}KB）`);
    ok++;
  } catch (e) {
    console.error(`✗ ${t.file_name} —— ${e.message}`);
    failed++;
  }
}

console.log(`\n完成：${ok} 下载 / ${skipped} 跳过 / ${failed} 失败 → ${outDir}`);
process.exit(failed === 0 ? 0 : 1);
