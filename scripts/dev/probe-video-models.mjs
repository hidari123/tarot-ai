#!/usr/bin/env node
/**
 * MiniMax 视频模型 —— 找到正确的模型名并实测生成（2026-11-11）
 *
 * ⚠️ 探测结果（scripts/dev/probe-minimax-cn.mjs）：
 *   · `video_generation` + `video-01` → **200 success** ✅（视频 API 是通的！）
 *   · `Hailuo-02` → "incorrect model param input"
 *   · `h3` → "incorrect model param input"
 *   → 说明端点对，但**模型名/参数结构**不对
 *
 * ⚠️ 已知 MiniMax 视频模型命名：video-01 / T2V-01 / T2V-01-Director / I2V-01 / S2V-01 / video-01-live
 *   → 逐个试
 *
 * 用法：node scripts/dev/probe-video-models.mjs
 */

import { readFileSync, existsSync } from "node:fs";

function loadKey() {
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf-8").split("\n")) {
      const m = line.match(/^\s*(DEEPSEEK_API_KEY)\s*=\s*(.+)\s*$/);
      if (m) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}
const key = loadKey();
if (!key) {
  console.error("✗ 没找到 key");
  process.exit(1);
}

const HOST = "https://api.minimaxi.com";

/** 候选视频模型名 */
const MODELS = [
  "video-01",
  "T2V-01",
  "T2V-01-Director",
  "T2V-01-live",
  "I2V-01",
  "I2V-01-Director",
  "S2V-01",
  "video-01-live",
  "MiniMax-Hailuo-02",
  "hailuo-02",
  "Hailuo-02",
  "hailuo2-01",
  "Hailuo2-01",
  "MiniMax-H3",
  "H3",
];

/** 最小合法 body（先只给 prompt，看模型名对不对） */
const body = { model: "", prompt: "a golden ball floating in dark space" };

console.log("=== 探测视频模型名 ===\n");

for (const model of MODELS) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(`${HOST}/v1/video_generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => ({}));
    const code = j.status_code ?? j.base_resp?.status_code;
    const msg = j.status_msg ?? j.base_resp?.status_msg ?? JSON.stringify(j).slice(0, 120);
    const taskId = j.task_id ?? j.video_id ?? j.id;
    const mark = code === 0 ? "✅ 可用" : "  ";
    console.log(`${mark} ${String(model).padEnd(22)} code=${code} ${String(msg).slice(0, 70)}${taskId ? `  task=${taskId}` : ""}`);
  } catch (e) {
    console.log(`   ${String(model).padEnd(22)} ERR ${e.message.slice(0, 60)}`);
  }
}
