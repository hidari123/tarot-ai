/**
 * HITL（Human-in-the-Loop）等待机制 —— 唯一的人机交互阻塞点
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 *
 * ⚠️ 这个模块为什么值得单独一个文件：
 *   HITL 是整个引擎里**唯一**会让生成器挂起的地方，也是最容易出
 *   状态不一致的地方（悬空 ask / 409 / 内存泄漏）。
 *   把它隔离出来，才能单独写测试（不需要拉起整个 agent）。
 *
 * 三条不变量（违反任意一条就是 bug）：
 *   1. 同一时刻**只能有一个** pendingAsk —— 多于一个时前端点哪个都不确定
 *   2. pendingAsk 必须**同步**设置在 await 之前 —— 否则前端抢跑会撞 409
 *   3. 等待必须有**超时 + 断开取消** —— 否则用户不答 = 永久内存泄漏
 *
 * ⚠️ 第四课（2026-11 加）：等待期间要**分级提醒**。
 *    原来只有一个 5 分钟的总超时 —— 用户走开一会儿回来，会话已经死了
 *    （"占卜师暂时失联"或静默收尾），体验很差。
 *    现在是三段式：
 *      30s  → 温和提醒（"我还在等你"），会话还活着
 *      2min → 再提醒一次（语气更明确）
 *      5min → 兜底收束（走降级路径，不让流程悬死）
 *    关键：提醒**不结束等待**，只是往流里推一个事件 ——
 *    这样前端能显示"占卜师在等你"，用户回来还能继续。
 */

import * as db from "../db";
import type { AgentSession, AskKind } from "./types";

/** HITL 总超时（默认 5 分钟）—— 超时以哨兵值 resolve，调用方走收尾路径 */
const HITL_TIMEOUT_MS = Number(process.env.HITL_TIMEOUT_MS) || 5 * 60 * 1000;

/**
 * 分级提醒的时间点（毫秒）
 *
 * ⚠️ 为什么是"递减间隔"（30s → 2min → 5min）：
 *    用户可能只是去倒杯水（30s 内回来），也可能真的走开了（5min）。
 *    前两次提醒给用户"机会回来"，最后一次是"我不再等了"的兜底。
 *    间隔刻意递减（30s→90s→180s），因为越到后期用户回来的概率越低，
 *    不值得再等那么久。
 */
const NUDGE_1_MS = Number(process.env.HITL_NUDGE_1_MS) || 30 * 1000;
const NUDGE_2_MS = Number(process.env.HITL_NUDGE_2_MS) || 2 * 60 * 1000;

/** 哨兵值：用户未回应（超时） */
const HITL_ABANDONED = "__hitl_abandoned__";
/** 哨兵值：客户端断开 */
const HITL_DISCONNECTED = "__hitl_disconnected__";

/**
 * 等待中的提醒回调
 *
 * ⚠️ 为什么不直接把提醒做成"结束等待"：
 *    提醒的价值在于**保住会话** —— 用户看到提示，回来还能接着答。
 *    如果提醒即结束，那和直接超��没区别。
 */
export type NudgeHandler = (level: 1 | 2, kind: AskKind | undefined, question: string) => void;

/**
 * 等待用户回答。
 *
 * ⚠️ 返回的 Promise **在调用时同步设置 session.pendingAsk**
 *    （Promise executor 是同步执行的）—— 这正是"先 waitUserAnswer
 *    再 yield card_flip_ready"的正确顺序所依赖的：
 *    前端收到"可点"信号时，后端已经在等了，不会抢跑撞 409。
 *
 * @param clock 活跃计时控制（进入等待暂停，结束恢复）——deadline 不计用户思考时间
 * @param onNudge 提醒回调（可选）——分级提醒时调用，用于往流里推事件
 */
export function waitUserAnswer(
  session: AgentSession,
  question: string,
  options: string[] | undefined,
  kind?: AskKind,
  clock?: { pause: () => void; resume: () => void },
  onNudge?: NudgeHandler
): Promise<string> {
  clock?.pause();
  const t0 = Date.now();
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(nudgeTimer1);
      clearTimeout(nudgeTimer2);
      session.pendingAsk = undefined;
      if (session.abortSignal) session.abortSignal.removeEventListener("abort", onAbort);
      clock?.resume();
      // HITL 等待耗时落库（瀑布数据：用户思考时间是隐藏的大头）
      db.logTiming(session.id, "hitl_wait", Date.now() - t0, kind ?? "ask");
      resolve(v);
    };
    const timer = setTimeout(() => finish(HITL_ABANDONED), HITL_TIMEOUT_MS);
    const onAbort = () => finish(HITL_DISCONNECTED);
    session.abortSignal?.addEventListener("abort", onAbort, { once: true });
    session.pendingAsk = { resolve: finish, question, options, kind };

    /* ---- 分级提醒：只提示，不结束等待 ---- */
    const nudgeTimer1 = setTimeout(() => {
      if (!settled) onNudge?.(1, kind, question);
    }, NUDGE_1_MS);
    const nudgeTimer2 = setTimeout(() => {
      if (!settled) onNudge?.(2, kind, question);
    }, NUDGE_2_MS);
  });
}

/** 判断 HITL 等待结果是否为放弃/中断哨兵 */
export function isHitlGone(answer: string): boolean {
  return answer === HITL_ABANDONED || answer === HITL_DISCONNECTED;
}

/** 提醒的文案（前端直接用，避免前端各自拼） */
export function nudgeText(level: 1 | 2, kind: AskKind | undefined): string {
  if (level === 1) {
    return kind === "flip"
      ? "占卜师还在等你的指引 —— 点开一张牌，我们就继续。"
      : "占卜师还在这里等你。";
  }
  return kind === "flip"
    ? "占卜师会再等一会儿…… 若你暂时离开，回来点开一张牌即可继续。"
    : "占卜师会再等一会儿 —— 你的回应会成为这次占卜的骨架。";
}

export { HITL_ABANDONED, HITL_DISCONNECTED, HITL_TIMEOUT_MS, NUDGE_1_MS, NUDGE_2_MS };
