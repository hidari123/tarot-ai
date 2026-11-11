#!/usr/bin/env node
/**
 * MiniMax 国内站（minimax.cn / platform.minimaxi.com）能力探测（2026-11-11）
 *
 * ⚠️⚠️ 为什么重新探测：
 *   之前只测了 **api.minimaxi.com**（国际站）→ 音乐 API 返回 410（对新用户关闭）
 *   但用户说国内站 minimax.cn 的 **build 套餐支持视频模型 h3 / 图像模型 h3 image / 声音模型**
 *   → 国际站和国内站的**账号体系、套餐、端点权限是分开的** ⚠️
 *   → 之前的结论只对国际站成立，不能推广到国内站
 *
 * ⚠️ 探测矩阵：
 *   端点 × 模型 × 领域
 *   · api.minimaxi.com（国际站）
 *   · api.minimax.cn / api.minimaxi.chat（国内站）
 *
 * 用法：node scripts/dev/probe-minimax-cn.mjs
 */

import { readFileSync, existsSync } from "node:fs";

/** 从 .env.local 读 key（不回显） */
function loadKeys() {
  const out = [];
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf-8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]*(?:KEY|TOKEN)[A-Z_]*)\s*=\s*(.+)\s*$/);
      if (m && m[2] && !m[2].startsWith("#")) {
        out.push({ name: m[1], value: m[2].replace(/^["']|["']$/g, "") });
      }
    }
  }
  return out;
}

const keys = loadKeys();
if (!keys.length) {
  console.error("✗ 没找到 API key（查 .env.local）");
  process.exit(1);
}
console.log(`找到 ${keys.length} 个 key：${keys.map((k) => k.name).join(", ")}\n`);

/** 候选域名（国内站 vs 国际站） */
const HOSTS = [
  { label: "国内 api.minimaxi.com", host: "https://api.minimaxi.com" },
  { label: "国内 api.minimax.cn", host: "https://api.minimax.cn" },
  { label: "国内 api.minimaxi.chat", host: "https://api.minimaxi.chat" },
  { label: "国际 api.minimax.io", host: "https://api.minimax.io" },
];

/** 端点 × 模型 */
const ENDPOINTS = [
  { path: "/v1/video_generation", body: { model: "video-01", prompt: "a cat" }, name: "video_generation" },
  { path: "/v1/video_generation", body: { model: "Hailuo-02", prompt: "a cat" }, name: "video_generation" },
  { path: "/v1/video_generation", body: { model: "h3", prompt: "a cat" }, name: "video_generation" },
  { path: "/v1/image_generation", body: { model: "image-01", prompt: "a cat", aspect_ratio: "1:1" }, name: "image_generation" },
  { path: "/v1/image_generation", body: { model: "h3-image", prompt: "a cat", aspect_ratio: "1:1" }, name: "image_generation" },
  { path: "/v1/image_generation", body: { model: "H3-Image", prompt: "a cat", aspect_ratio: "1:1" }, name: "image_generation" },
  { path: "/v1/music_generation", body: { model: "music-01", prompt: "a song" }, name: "music_generation" },
  { path: "/v1/music_generation", body: { model: "music-2.5", prompt: "a song" }, name: "music_generation" },
  { path: "/v1/t2a_v2", body: { model: "speech-02-hd", text: "你好" }, name: "tts" },
  { path: "/v1/text-to-speech", body: { model: "speech-02-hd", text: "你好" }, name: "tts_alt" },
  { path: "/v1/chat/completions", body: { model: "MiniMax-M2", messages: [{ role: "user", content: "hi" }] }, name: "chat" },
];

const key = keys[0].value;

for (const h of HOSTS) {
  console.log(`\n${"=".repeat(70)}\n${h.label}  (${h.host})\n${"=".repeat(70)}`);
  for (const ep of ENDPOINTS) {
    const url = h.host + ep.path;
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "GroupId": process.env.MINIMAX_GROUP_ID ?? "",
        },
        body: JSON.stringify(ep.body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ms = Date.now() - started;
      const text = await res.text();
      let snippet = text.slice(0, 200);
      try {
        const j = JSON.parse(text);
        snippet = JSON.stringify(j.base_resp ?? j).slice(0, 220);
      } catch {
        /* 非 JSON */
      }
      console.log(
        `  ${res.status} ${ep.name.padEnd(18)} ${ep.body.model.padEnd(14)} ${String(ms).padStart(6)}ms  ${snippet}`
      );
    } catch (e) {
      const ms = Date.now() - started;
      console.log(`  ERR ${ep.name.padEnd(18)} ${ep.body.model.padEnd(14)} ${String(ms).padStart(6)}ms  ${e.message.slice(0, 90)}`);
    }
  }
}
