/**
 * 会话生命周期 —— 内存态管理 + TTL 清理 + 启动对账
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。职责边界：
 *   本文件只管"会话存哪、什么时候死、怎么落库"
 *   HITL 等待机制在 hitl.ts，LLM 调用在 llm.ts
 *
 * ⚠️ 状态分层设计（面试可讲）：
 *   - 内存 Map：热状态，读写快，但进程重启全丢
 *   - SQLite：持久化（历史/dashboard/画像）
 *   内存态 + 持久化的取舍：内存保证单场占卜的低延迟，
 *   持久化保证"事后可查"（dashboard/分享卡/画像）。
 */

import * as db from "../db";
import { PERSONAS } from "../personas";
import type { AgentSession } from "./types";

/**
 * 内存会话表 —— globalThis 单例。
 * ⚠️ 为什么要 globalThis：Next.js dev 模式会热重载模块，
 *    普通 module-level Map 每次热重载都会被重建（会话凭空消失）。
 *    挂在 globalThis 上跨热重载存活。
 */
const sessions: Map<string, AgentSession> = (() => {
  const g = globalThis as unknown as { __tarotSessions__?: Map<string, AgentSession> };
  if (!g.__tarotSessions__) g.__tarotSessions__ = new Map();
  return g.__tarotSessions__;
})();

/** 会话存活时长（30 分钟）—— 超过未活动即逐出 */
const SESSION_TTL = 30 * 60 * 1000;

/**
 * 启动对账（只执行一次）
 *
 * 进程重启会让内存会话全部丢失，但 SQLite 里这些会话还停在 running。
 * 启动时把"创建于 30 分钟前且仍是 running"的标记为 error（stale_timeout），
 * 避免 dashboard 出现永远运行中的僵尸数据。
 *
 * ⚠️ P1-④ 改进：先尝试**恢复**有快照的会话（恢复成功就不该标 error），
 *    只对"既没快照、也超时的"才标记僵死。
 */
function reconcileOnBoot(): void {
  const g = globalThis as unknown as { __tarotReconciled__?: boolean };
  if (g.__tarotReconciled__) return;
  g.__tarotReconciled__ = true;

  // ---- ① 先恢复有快照的会话 ----
  let restored = 0;
  try {
    const rows = db.listRecoverableSessions(0);
    for (const row of rows) {
      try {
        const snap = JSON.parse(row.state_json) as SessionSnapshot;
        if (!snap?.id) continue;
        // ⚠️ 只恢复"还在 TTL 内"的会话 —— 超过 30 分钟的恢复出来也没意义
        if (Date.now() - (snap.lastActive ?? 0) > SESSION_TTL) continue;
        if (restoreSession(snap)) restored++;
      } catch { /* 单条恢复失败不影响其他 */ }
    }
    if (restored > 0) console.error(`[session-restore] 从快照恢复 ${restored} 个未完结会话`);
  } catch (e) {
    console.error("[session-restore] 失败:", e instanceof Error ? e.message : e);
  }

  // ---- ② 再把真正僵死的标记为 error ----
  try {
    const n = db.reconcileStaleSessions(SESSION_TTL);
    if (n > 0) console.error(`[session-reconcile] 清理 ${n} 个僵死会话（进程重启遗留）`);
  } catch (e) {
    console.error("[session-reconcile] 失败:", e instanceof Error ? e.message : e);
  }
}

/* ------------------------------------------------------------------ */
/* 状态快照（P1-④）                                                    */
/* ------------------------------------------------------------------ */

/** 会话是否需要落快照（脏标记） */
const dirty = new Set<string>();

/** 标记会话状态已变更（下次 persistAll 时落库） */
export function markSessionDirty(id: string): void {
  dirty.add(id);
}

/**
 * 把脏会话的快照落库。
 *
 * ⚠️ 频率是权衡：
 *   - 每次事件都写 → SQLite 写放大（一场占卜 ~50 事件）
 *   - 从不写 → 重启丢状态
 *   折中：标脏 + 定时（10s）+ 关键点（翻牌/解读完成/收束）触发。
 */
export function persistDirtySessions(): number {
  let n = 0;
  for (const id of dirty) {
    const s = sessions.get(id);
    if (!s) { dirty.delete(id); continue; }
    try {
      db.saveSessionState(id, snapshotSession(s));
      n++;
    } catch { /* 落库失败不阻断 */ }
    dirty.delete(id);
  }
  return n;
}

// 定时落盘（10 秒一次）
const gPersist = globalThis as unknown as { __tarotPersistTimer__?: NodeJS.Timeout };
if (!gPersist.__tarotPersistTimer__) {
  gPersist.__tarotPersistTimer__ = setInterval(() => {
    try { persistDirtySessions(); } catch { /* ignore */ }
  }, 10_000);
  gPersist.__tarotPersistTimer__.unref?.(); // 不阻塞进程退出
}

/** 逐出过期的会话（落库收尾 → 删除内存态） */
export function cleanExpired(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) {
      // 逐出前落库收尾：开着页面不答/生成器泄漏的会话在 DB 里仍是 running，
      // 不收尾就成僵尸行（此前要等下次进程重启才被 reconcile 清掉）
      if (!s.finished) {
        try { db.failSession(id, "ttl_expired"); } catch { /* ignore */ }
      }
      sessions.delete(id);
    }
  }
}

// 定时清理（此前只挂在 createSession：无新建即永不清理，Map 无限增长）
const CLEAN_INTERVAL_MS = 5 * 60 * 1000;
const gTimer = globalThis as unknown as { __tarotCleanTimer__?: NodeJS.Timeout };
if (!gTimer.__tarotCleanTimer__) {
  gTimer.__tarotCleanTimer__ = setInterval(() => {
    try { cleanExpired(); } catch { /* ignore */ }
  }, CLEAN_INTERVAL_MS);
  gTimer.__tarotCleanTimer__.unref?.(); // 不阻塞进程退出
}

/** 创建新会话（同时落库一条 running 记录） */
export function createSession(question: string, personaId?: string, userKey?: string): AgentSession {
  cleanExpired();
  const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const persona = PERSONAS.find((p) => p.id === personaId) ?? PERSONAS[0];
  const session: AgentSession = {
    id, createdAt: Date.now(), lastActive: Date.now(),
    messages: [], question, persona,
    drawnCards: [], ragHits: [], analystNotes: "",
    finished: false, toolSeq: 0,
    ragQueryHistory: [], ragCallCount: 0, dwellTimes: [], emotionTags: [],
    cardReadings: [], interjections: [], pendingInterjections: [],
    userKey,
  };
  sessions.set(id, session);
  db.insertSession(id, question, persona.id, []);
  // 新会话立刻落一次快照（保证进程在第一次事件前崩溃也能恢复）
  dirty.add(id);
  try { db.saveSessionState(id, snapshotSession(session)); } catch { /* ignore */ }
  return session;
}

/** 取会话（会刷新 lastActive —— 活跃度心跳） */
export function getSession(id: string): AgentSession | undefined {
  const s = sessions.get(id);
  if (s) s.lastActive = Date.now();
  return s;
}

/** 列出所有内存会话（调试/dashboard 用） */
export function listSessions(): AgentSession[] {
  return [...sessions.values()];
}

/**
 * 会话快照 —— 供持久化模块使用（进程重启后恢复）
 *
 * ⚠️ pendingAsk **不能**序列化：它持有 Promise 闭包，
 *    恢复出来的会话只能"看"不能"等"（前端追问会得到明确的
 *    "会话已过期"而不是挂死）。
 */
export interface SessionSnapshot {
  id: string;
  createdAt: number;
  lastActive: number;
  question: string;
  personaId: string;
  messages: AgentSession["messages"];
  drawnCards: AgentSession["drawnCards"];
  ragHits: AgentSession["ragHits"];
  analystNotes: string;
  finished: boolean;
  toolSeq: number;
  ragQueryHistory: string[];
  ragCallCount: number;
  dwellTimes: number[];
  emotionTags: string[];
  contractQuestion?: string;
  scopeNote?: string;
  invocationAnswers?: string[];
  interjections: string[];
  pendingInterjections: string[];
  userKey?: string;
  cardReadings: AgentSession["cardReadings"];
  plan?: string[];
  agentMode?: "plan" | "react";
  flippedCardIdx?: number[];
}

/** 导出可持久化的快照（剔除不可序列化的 pendingAsk） */
export function snapshotSession(s: AgentSession): SessionSnapshot {
  return {
    id: s.id,
    createdAt: s.createdAt,
    lastActive: s.lastActive,
    question: s.question,
    personaId: s.persona.id,
    messages: s.messages,
    drawnCards: s.drawnCards,
    ragHits: s.ragHits,
    analystNotes: s.analystNotes,
    finished: s.finished,
    toolSeq: s.toolSeq,
    ragQueryHistory: s.ragQueryHistory,
    ragCallCount: s.ragCallCount,
    dwellTimes: s.dwellTimes,
    emotionTags: s.emotionTags,
    contractQuestion: s.contractQuestion,
    scopeNote: s.scopeNote,
    invocationAnswers: s.invocationAnswers,
    interjections: s.interjections,
    pendingInterjections: s.pendingInterjections,
    userKey: s.userKey,
    cardReadings: s.cardReadings,
    plan: s.plan,
    agentMode: s.agentMode,
    flippedCardIdx: s.flippedCardIdx,
  };
}

/**
 * 从快照恢复会话（进程重启后）—— 返回 null 表示不可恢复。
 *
 * ⚠️ 恢复出的会话 **finished=false 但没有 pendingAsk**：
 *    下一步（翻牌闸门）无法 await —— 端点会明确返回 410 让前端
 *    引导用户重新开始，而不是让前端等一个永远不会来的事件。
 */
export function restoreSession(snap: SessionSnapshot): AgentSession | null {
  try {
    const persona = PERSONAS.find((p) => p.id === snap.personaId) ?? PERSONAS[0];
    const s: AgentSession = {
      id: snap.id,
      createdAt: snap.createdAt,
      lastActive: Date.now(),
      messages: snap.messages ?? [],
      question: snap.question,
      persona,
      drawnCards: snap.drawnCards ?? [],
      ragHits: snap.ragHits ?? [],
      analystNotes: snap.analystNotes ?? "",
      finished: snap.finished,
      toolSeq: snap.toolSeq ?? 0,
      ragQueryHistory: snap.ragQueryHistory ?? [],
      ragCallCount: snap.ragCallCount ?? 0,
      dwellTimes: snap.dwellTimes ?? [],
      emotionTags: snap.emotionTags ?? [],
      contractQuestion: snap.contractQuestion,
      scopeNote: snap.scopeNote,
      invocationAnswers: snap.invocationAnswers,
      interjections: snap.interjections ?? [],
      pendingInterjections: snap.pendingInterjections ?? [],
      userKey: snap.userKey,
      cardReadings: snap.cardReadings ?? [],
      plan: snap.plan,
      agentMode: snap.agentMode,
      flippedCardIdx: snap.flippedCardIdx,
      // ⚠️ 标记：恢复的会话没有 pendingAsk（Promise 不可序列化）
      restoredFromSnapshot: true,
    };
    sessions.set(s.id, s);
    return s;
  } catch {
    return null;
  }
}

export { reconcileOnBoot };
