/**
 * 事件日志 —— 带序号的事件流（P2-⑦ 可观测性 + P1-③D 断点续传）
 *
 * ⚠️ 为什么需要：
 *   流式 AI 应用的真实难点不是"推流"，是**断流**。
 *   断线后：
 *   - 旧实现：用户只能刷新页面 → 整场对话重来
 *   - 现在：会话状态能恢复（P1-④），但**事件流补不回来** ——
 *     用户看到的是"对话开始了但内容是空的"
 *
 *   方案：给每个事件打**单调递增 seq**，存进 ring buffer；
 *   前端重连时带 `Last-Event-ID: <seq>`，后端补发缺失的事件。
 *
 * ⚠️ 存储选型（面试可讲）：
 *   - 内存 ring buffer：快，但进程重启丢（可接受 —— 状态快照另有持久化）
 *   - SQLite 事件表：持久，但每事件一次写（一场占卜 ~50 事件 × N 用户）
 *   取舍：**内存 ring buffer + 关键事件落库**（tool/phase/card_*），
 *   兼顾"断线快速补发"与"事后可查"。
 *
 *   同时提供事件日志落库（P2-⑦），让 dashboard 能画出完整时间线。
 */

import * as db from "../db";
import type { AgentEvent } from "./types";

/* ------------------------------------------------------------------ */
/* 内存 ring buffer（断点续传用）                                       */
/* ------------------------------------------------------------------ */

interface BufferedEvent {
  seq: number;
  evt: AgentEvent;
  ts: number;
}

/** 每场会话的事件缓冲 */
interface SessionBuffer {
  events: BufferedEvent[];
  nextSeq: number;
}

const buffers = new Map<string, SessionBuffer>();

/** 单会话最多缓冲多少事件（超出丢最旧的 —— 断点续传只需要"最近的一段"） */
const MAX_BUFFER = 500;

/** 会话缓冲 TTL（超过就清理，避免内存泄漏） */
const BUFFER_TTL_MS = 30 * 60 * 1000;

/** 取（或建）会话缓冲 */
function getBuffer(sessionId: string): SessionBuffer {
  let b = buffers.get(sessionId);
  if (!b) {
    b = { events: [], nextSeq: 1 };
    buffers.set(sessionId, b);
  }
  return b;
}

/**
 * 记录一个事件 → 返回带 seq 的事件（供 SSE 下发）。
 *
 * ⚠️ seq 从 1 开始（0 保留给"没有 Last-Event-ID"）。
 */
export function recordEvent(sessionId: string, evt: AgentEvent): { seq: number; evt: AgentEvent } {
  const buf = getBuffer(sessionId);
  const seq = buf.nextSeq++;
  buf.events.push({ seq, evt, ts: Date.now() });
  // 超容量：丢最旧的（保留最近 MAX_BUFFER 条）
  if (buf.events.length > MAX_BUFFER) {
    buf.events.splice(0, buf.events.length - MAX_BUFFER);
  }
  return { seq, evt };
}

/**
 * 取 seq 之后的事件（断点续传补发）。
 *
 * @param lastSeq 客户端收到的最后一个 seq（0 = 从头）
 * @returns 需要补发的事件列表
 */
export function eventsSince(sessionId: string, lastSeq: number): Array<{ seq: number; evt: AgentEvent }> {
  const buf = buffers.get(sessionId);
  if (!buf) return [];
  return buf.events
    .filter((e) => e.seq > lastSeq)
    .map((e) => ({ seq: e.seq, evt: e.evt }));
}

/** 当前会话的最后一个 seq */
export function lastSeq(sessionId: string): number {
  const buf = buffers.get(sessionId);
  return buf ? buf.nextSeq - 1 : 0;
}

/** 清理会话缓冲（会话结束/过期后） */
export function clearBuffer(sessionId: string): void {
  buffers.delete(sessionId);
}

/* ------------------------------------------------------------------ */
/* 事件日志落库（P2-⑦ 可观测性）                                       */
/* ------------------------------------------------------------------ */

/**
 * 哪些事件值得落库？
 *
 * ⚠️ 不落 delta —— 一场占卜的正文可能有几百个 delta 事件，
 *    全落库会让 event_log 变成第二个 reading 表（冗余且量大）。
 *    落"结构性事件"就够画时间线了。
 */
const PERSIST_TYPES = new Set([
  "session", "phase", "tool", "cards", "ask_user", "subagent",
  "review", "card_reveal", "card_reading", "card_flip_ready",
  "contract", "invocation", "round", "plan", "persona_suggest",
  "done", "error",
]);

/**
 * 记录事件到数据库（仅结构性事件）。
 *
 * ⚠️ 失败不阻断 —— 可观测性是"锦上添花"，不能因为它拖垮占卜。
 */
export function persistEvent(sessionId: string, seq: number, evt: AgentEvent): void {
  if (!PERSIST_TYPES.has(evt.type)) return;
  try {
    db.logEvent(sessionId, seq, evt.type, JSON.stringify(evt), Date.now());
  } catch { /* 落库失败不阻断主线 */ }
}

/* ------------------------------------------------------------------ */
/* 定时清理                                                            */
/* ------------------------------------------------------------------ */

const g = globalThis as unknown as { __tarotEventCleanTimer__?: NodeJS.Timeout };
if (!g.__tarotEventCleanTimer__) {
  g.__tarotEventCleanTimer__ = setInterval(() => {
    const now = Date.now();
    for (const [id, b] of buffers) {
      const last = b.events[b.events.length - 1];
      if (last && now - last.ts > BUFFER_TTL_MS) buffers.delete(id);
    }
  }, 5 * 60 * 1000);
  g.__tarotEventCleanTimer__.unref?.();
}
