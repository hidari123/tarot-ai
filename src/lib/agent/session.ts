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
import { generateSessionId } from "../api-auth";
import { runtimeState } from "../runtime";
import type { AgentSession } from "./types";
import { derivePhase, type RitualPhase } from "./ritual-machine";
import { DEFAULT_MODE, type DivinationMode } from "./divination-mode";
import { DEFAULT_KIND, type SessionKind } from "./session-kind";

/**
 * 内存会话表 —— globalThis 单例。
 * ⚠️ 为什么要 globalThis：Next.js dev 模式会热重载模块，
 *    普通 module-level Map 每次热重载都会被重建（会话凭空消失）。
 *    挂在 globalThis 上跨热重载存活。
 *
 * ⚠️ P1-⑥：改用统一的 runtimeState 入口（src/lib/runtime.ts）——
 *    让所有跨请求状态都走同一个容器，便于审计"哪些状态是进程级的"。
 */
const sessions: Map<string, AgentSession> = runtimeState<Map<string, AgentSession>>(
  "session.sessions",
  () => new Map<string, AgentSession>()
);

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
        /**
         * ⚠️ P2-⑨：用 `loadSessionState` 而不是直接 JSON.parse(state_json) ——
         *   消息已被剥离到 `session_messages`（append-only 表），
         *   直接解析 state_json 会**丢掉全部历史消息** → 恢复出来的会话是空的。
         *   loadSessionState 会把 messages 拼回来（对上层透明）。
         */
        const snap = db.loadSessionState(row.id) as SessionSnapshot | null;
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

/**
 * 会话是否需要落快照（脏标记）
 *
 * ⚠️ P1-⑥：挂到 globalThis —— 原来这里是**模块级** Set，
 *    HMR 重载会清空 → 落在重载后的会话**永远不会被落快照**
 *    → 进程重启后该会话无法恢复。
 */
const dirty = runtimeState<Set<string>>("session.dirty", () => new Set<string>());

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
    // ⚠️ 这里**必须**捕获异常：setInterval 回调里抛出的异常会变成
    //    uncaughtException → **整个进程崩溃**（不只是这次落盘失败）。
    //    但不捕获也不行（不捕获 = 崩），所以捕获 + 留 debug 痕迹。
    try { persistDirtySessions(); } catch (e) { console.debug("[session] 定时落盘失败:", e); }
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
        // ⚠️ 同上：定时器回调里不能抛异常
        try { db.failSession(id, "ttl_expired"); } catch (e) { console.debug("[session] 逐出落库失败:", e); }
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
    // ⚠️ 定时器回调不能抛异常（会崩进程）
    try { cleanExpired(); } catch (e) { console.debug("[session] 定时清理失败:", e); }
  }, CLEAN_INTERVAL_MS);
  gTimer.__tarotCleanTimer__.unref?.(); // 不阻塞进程退出
}

/** 创建新会话（同时落库一条 running 记录） */
export function createSession(
  question: string,
  personaId?: string,
  userKey?: string,
  mode: DivinationMode = DEFAULT_MODE,
  kind: SessionKind = DEFAULT_KIND
): AgentSession {
  cleanExpired();
  // ⚠️ P1-④：会话 id 改为 **192bit 全随机**（不再是"时间戳 + 6 位随机"）
  //   旧格式 `sess_${Date.now().toString(36)}_${random6}` 的问题：
  //     · Date.now() 部分**可枚举**（攻击者能遍历最近的时间窗口）
  //     · random6 只有 ~2.2B 空间
  //   而 sessionId 就是**会话控制凭证**（能 answer/interject = 能替用户操作），
  //   必须不可枚举。
  const id = generateSessionId();
  const persona = PERSONAS.find((p) => p.id === personaId) ?? PERSONAS[0];
  const session: AgentSession = {
    id, createdAt: Date.now(), lastActive: Date.now(),
    messages: [], question, persona,
    drawnCards: [], ragHits: [], analystNotes: "",
    finished: false, toolSeq: 0,
    ragQueryHistory: [], ragCallCount: 0, dwellTimes: [], emotionTags: [],
    cardReadings: [], interjections: [], pendingInterjections: [],
    userKey,
    // P1-⑩：新会话一律从"承约"开始（仪式第一站）
    // ⚠️ 2026-11-04 D 方向：神谕不走仪式状态机 —— 起点标为 "done"，
    //   这样任何按阶段推进的逻辑（守卫/提示）都不会误触发。
    ritualPhase: kind === "oracle" ? "done" : "contract",
    // 2026-11-04 双模式：占卜模式（快速/深度）
    mode,
    // 2026-11-04 D 方向：会话种类（占卜 / 神谕）
    kind,
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

/**
 * 原子地"检查并占用"会话（用于防并发追问）
 *
 * ⚠️ 为什么需要这个函数（TOCTOU 竞态）：
 *   原来的写法是**分开**的两步：
 *     ① 路由层：if (session.busy) return 409;   ← 检查
 *     ② supervisor：session.busy = true;         ← 设置（在生成器首次 next() 时）
 *   两步之间有一个 **await 间隙**（生成器启动是异步的）：
 *     两个并发 POST /api/interpret（同一 sessionId）
 *     → 都通过 ① 的检查 → 都进入 runAgent
 *     → 各自往 session.messages push 消息
 *     → **assistant→tool 配对错位**
 *     → MiniMax 报 400 "tool call result does not follow tool call"
 *     → 该会话之后的**所有**追问都失败（历史已被污染）
 *
 * ⚠️ 怎么做到原子：
 *   Node 是单线程 —— 只要"检查 + 设置"在**同一个同步段**里完成，
 *   就不可能有另一个请求插进来（中间没有 await）。
 *   本函数就是那个同步段。
 *
 * @returns true = 占用成功（调用方负责在 finally 里释放）
 */
export function tryAcquireSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.busy) return false;
  s.busy = true;
  return true;
}

/** 释放会话占用（与 tryAcquireSession 配对） */
export function releaseSession(id: string): void {
  const s = sessions.get(id);
  if (s) s.busy = false;
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
  /** P1-⑩：仪式阶段（老会话没有 → 恢复时 derivePhase 反推） */
  ritualPhase?: RitualPhase;
  /**
   * 占卜模式（2026-11-04 双模式）
   * ⚠️ 老会话没有 → 恢复时按 "deep" 处理（保持原行为）
   */
  mode?: DivinationMode;
  /**
   * 会话种类（2026-11-04 D 方向）
   * ⚠️ 老会话没有 → 恢复时按 "divination" 处理（保持原行为）
   */
  kind?: SessionKind;
  invocationAnswers?: string[];
  /** 三问呼召的完整问答对（P1-⑩ 推导仪式阶段时需要） */
  invocation?: { questions: string[]; answers: string[] };
  interjections: string[];
  pendingInterjections: string[];
  userKey?: string;
  cardReadings: AgentSession["cardReadings"];
  plan?: string[];
  agentMode?: "plan" | "react";
  flippedCardIdx?: number[];
  /** P2-⑨：综合正文（恢复后 /api/session/[id] 要返回它） */
  reading?: string;
  /** P2-⑨：综合是否已完成（close_reading 守卫的前置条件） */
  synthesisDone?: boolean;
  /** P3-⑩：输出是否被截断（审校结论不计入通过率） */
  outputTruncated?: boolean;
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
    // P1-⑩：仪式阶段进快照（老会话没有 → 恢复时从其它字段推导）
    ritualPhase: s.ritualPhase,
    // 2026-11-04：占卜模式进快照（恢复后必须保持同一模式，否则仪式路径会变）
    mode: s.mode,
    // 2026-11-04 D 方向：会话种类进快照（恢复后必须保持同一形态）
    kind: s.kind,
    invocationAnswers: s.invocationAnswers,
    interjections: s.interjections,
    pendingInterjections: s.pendingInterjections,
    userKey: s.userKey,
    cardReadings: s.cardReadings,
    plan: s.plan,
    agentMode: s.agentMode,
    flippedCardIdx: s.flippedCardIdx,
    // P2-⑨/P3-⑩：恢复后仍需保留这三个字段
    //    · reading —— /api/session/[id] 的 live 分支返回它，丢了正文就"刷新即空"
    //    · synthesisDone —— close_reading 守卫的前置（丢了会被永远拦截）
    //    · outputTruncated —— 审校结论是否计入通过率
    reading: s.reading,
    synthesisDone: s.synthesisDone,
    outputTruncated: s.outputTruncated,
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
      // ⚠️ 必须保留**原始** lastActive，不能填 Date.now()。
      //    否则恢复一个 3 天前的僵尸会话时，它会"看起来刚刚活跃"，
      //    随后 persist 又把这个假心跳写回快照 → 永久保鲜 →
      //    会话永远停在 running，还占着 LLM 网关的并发槽位（限流恢复不了）。
      //    真实活跃时间由 getSession（心跳）与 markSessionDirty 维护。
      lastActive: snap.lastActive ?? Date.now(),
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
      // P1-⑩：仪式阶段 —— 老会话没有这个字段，用 derivePhase 从其它字段反推。
      // ⚠️ 必须反推而不是默认 "contract"：
      //    否则恢复一个"已经承约完、正准备翻牌"的会话时，
      //    守卫会认为它还在承约阶段 → 用户看到"请先承约"（明明已经承约过了）。
      // ⚠️ 2026-11-04 D 方向：神谕会话不走仪式 → 恒为 "done"
      //    （若按 derivePhase 反推会得到 "contract" → 触发承约守卫 → 神谕卡死）
      ritualPhase:
        snap.kind === "oracle"
          ? "done"
          : snap.ritualPhase ?? derivePhase({
              finished: snap.finished,
              contractQuestion: snap.contractQuestion,
              invocation: snap.invocation,
              drawnCards: snap.drawnCards,
              cardReadings: snap.cardReadings,
            }),
      invocationAnswers: snap.invocationAnswers,
      // 2026-11-04：占卜模式 —— 老会话没有 → 按 "deep" 处理（保持原行为）
      // ⚠️ 不能用 DEFAULT_MODE（quick）：老会话是**深度**仪式产生的，
      //    按 quick 恢复会让它跳过已经完成的阶段。
      mode: snap.mode ?? "deep",
      // 2026-11-04 D 方向：会话种类 —— 老会话没有 → 按 "divination" 处理
      kind: snap.kind ?? DEFAULT_KIND,
      interjections: snap.interjections ?? [],
      pendingInterjections: snap.pendingInterjections ?? [],
      userKey: snap.userKey,
      cardReadings: snap.cardReadings ?? [],
      plan: snap.plan,
      agentMode: snap.agentMode,
      flippedCardIdx: snap.flippedCardIdx,
      // P2-⑨/P3-⑩：恢复这三个字段
      //    · reading —— 丢了正文，用户刷新后看到空的解读
      //    · synthesisDone —— 丢了会被 close_reading 守卫永远拦截（收束语出不来）
      //    · outputTruncated —— 审校结论是否计入通过率
      reading: snap.reading,
      synthesisDone: snap.synthesisDone,
      outputTruncated: snap.outputTruncated,
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
