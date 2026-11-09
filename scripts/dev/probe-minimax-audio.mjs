#!/usr/bin/env node
/**
 * MiniMax 音频/音乐端点探测（2026-11-06）
 *
 * ⚠️ 为什么需要这个脚本：
 *   用户问"我这个 key 不行吗" —— 必须**实测**而不是猜。
 *   PowerShell 里 curl/Invoke 的引号与转义太容易出错（中文 body 会被搞坏），
 *   → 用 Node 直接 fetch，最可控。
 *
 * ⚠️ 探测矩阵：
 *   · 端点：music_generation / audio_generation / t2a_v2 / v1/audio/...
 *   · 模型：music-01 / music-1.5 / music-2 / music-2.5 / speech-02-hd ...
 *
 * 用法：node scripts/dev/probe-minimax-audio.mjs
 */

import { readFileSync, existsSync } from "node:fs";

function loadEnv(file = ".env.local") {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv();
const base = (env.OPENAI_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/+$/, "");
const key = env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;

if (!key) {
  console.error("✗ 找不到 DEEPSEEK_API_KEY");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

/** 探测表：端点 × 模型 × body */
const CASES = [
  // 音乐生成（各种模型名）
  ["music_generation", "music-01", { model: "music-01", prompt: "ambient mystical music", lyrics: "[Instrumental]" }],
  ["music_generation", "music-1.5", { model: "music-1.5", prompt: "ambient mystical music", lyrics: "[Instrumental]" }],
  ["music_generation", "music-2", { model: "music-2", prompt: "ambient mystical music", lyrics: "[Instrumental]" }],
  ["music_generation", "music-2.5", { model: "music-2.5", prompt: "ambient mystical music", lyrics: "[Instrumental]" }],
  // 无 music 前缀的端点
  ["audio_generation", "music-01", { model: "music-01", prompt: "ambient mystical music" }],
  // TTS（已知可用，验证 key 有效）
  ["t2a_v2", "speech-02-hd", { model: "speech-02-hd", text: "测试", stream: false }],
  // 其他可能的路径
  ["v1/music_generation", "music-01", { model: "music-01", prompt: "ambient mystical music" }],
  ["audio/music", "music-01", { model: "music-01", prompt: "ambient mystical music" }],
];

console.log(`base: ${base}\n`);

for (const [ep, model, body] of CASES) {
  const url = `${base}/${ep}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let msg = "";
    try {
      const j = JSON.parse(text);
      msg = j?.base_resp?.status_msg || j?.base_resp?.status_code || "";
      if (j?.data?.audio || j?.data?.audio_url || j?.data?.url) {
        msg = "HAS_AUDIO! " + JSON.stringify(j.data).slice(0, 120);
      }
    } catch {
      msg = text.slice(0, 100);
    }
    const ok = res.ok && !/no longer available|invalid|not found|error/i.test(String(msg));
    console.log(`${ok ? "✓" : "✗"} ${ep} [${model}] → ${res.status} ${msg}`);
  } catch (e) {
    console.log(`✗ ${ep} [${model}] → ${e.message.slice(0, 60)}`);
  }
}
