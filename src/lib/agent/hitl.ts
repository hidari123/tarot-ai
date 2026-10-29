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
 */

import * as db from "../db";
import type { AgentSession, AskKind } from "./types";

/** HITL 超时（默认 5 分钟）—— 超时以哨兵值 resolve，调用方走收尾路径 */
const HITL_TIMEOUT_MS = Number(process.env.HITL_TIMEOUT_MS) || 5 * 60 * 1000;

/** 哨兵值：用户未回应（超时） */
const HITL_ABANDONED = "__hitl_abandoned__";
/** 哨兵值：客户端断开 */
const HITL_DISCONNECTED = "__hitl_disconnected__";

/**
 * 等待用户回答。
 *
 * ⚠️ 返回的 Promise **在调用时同步设置 session.pendingAsk**
 *    （Promise executor 是同步执行的）—— 这正是"先 waitUserAnswer
 *    再 yield card_flip_ready"的正确顺序所依赖的：
 *    前端收到"可点"信号时，后端已经在等了，不会抢跑撞 409。
 *
 * @param clock 活跃计时控制（进入等待暂停，结束恢复）——deadline 不计用户思考时间
 */
export function waitUserAnswer(
  session: AgentSession,
  question: string,
  options: string[] | undefined,
  kind?: AskKind,
  clock?: { pause: () => void; resume: () => void }
): Promise<string> {
  clock?.pause();
  const t0 = Date.now();
  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (v: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
  });
}

/** 判断 HITL 等待结果是否为放弃/中断哨兵 */
export function isHitlGone(answer: string): boolean {
  return answer === HITL_ABANDONED || answer === HITL_DISCONNECTED;
}

export { HITL_ABANDONED, HITL_DISCONNECTED, HITL_TIMEOUT_MS };
