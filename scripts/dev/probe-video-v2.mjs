#!/usr/bin/env node
/**
 * MiniMax H3 视频 —— v2 端点探测（2026-11-11）
 *
 * ⚠️ 关键发现（scripts/dev/probe-video-models.mjs）：
 *   `MiniMax-H3` 在 /v1/video_generation 返回：
 *     "该模型请使用 /v2/video_generation 接口"
 *   → **H3 走 v2** ✅ 这就是用户说的"build 套餐支持视频模型 h3"
 *
 * ⚠️ 已确认可用的模型名（v1 端点）：
 *   video-01 / T2V-01 / T2V-01-Director / MiniMax-Hailuo-02
 *   I2V-01（需 first_frame_image）/ S2V-01（需 subject_reference）
 *
 * 用法：node scripts/dev/probe-video-v2.mjs
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
const HOST = "https://api.minimaxi.com";

console.log("=== /v2/video_generation 探测 ===\n");

/** v2 的模型名候选 */
const MODELS = ["MiniMax-H3", "H3", "h3", "MiniMax-H3-Director", "H3-Director"];

/** v2 的 body 结构候选（v2 可能改成 openai 风格） */
const BODIES = [
  { label: "flat(prompt)", body: { model: "", prompt: "a golden ball in dark space" } },
  { label: "messages[]", body: { model: "", messages: [{ role: "user", content: "a golden ball in dark space" }] } },
  { label: "flat+duration", body: { model: "", prompt: "a golden ball", duration: 6, resolution: "1080P" } },
];

for (const model of MODELS) {
  for (const b of BODIES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(`${HOST}/v2/video_generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...b.body, model }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const txt = await res.text();
      let j = {};
      try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
      const code = j.status_code ?? j.base_resp?.status_code ?? j.code;
      const msg = j.status_msg ?? j.base_resp?.status_msg ?? j.message ?? txt.slice(0, 110);
      const task = j.task_id ?? j.id ?? j.data?.task_id;
      const mark = code === 0 || res.status === 200 ? "✅" : "  ";
      console.log(`${mark} ${model.padEnd(20)} ${b.label.padEnd(14)} http=${res.status} code=${code ?? "-"} ${String(msg).slice(0, 60)}${task ? ` task=${task}` : ""}`);
      if (code === 0 || task) {
        console.log(`   → 完整响应: ${txt.slice(0, 400)}`);
      }
    } catch (e) {
      console.log(`   ${model.padEnd(20)} ${b.label.padEnd(14)} ERR ${e.message.slice(0, 50)}`);
    }
  }
}
