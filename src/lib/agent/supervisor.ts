/**
 * Supervisor 主循环 —— 占卜师编排者（ReAct / Plan-Execute）
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构，2590 行 → 本文件 ~1250 行）。
 *
 * ⚠️ 这个文件是整个引擎的**编排中枢**，它只做编排，不做实现：
 *   - 会话状态      → session.ts
 *   - HITL 等待     → hitl.ts
 *   - LLM 调用      → llm.ts
 *   - 工具定义      → tools/definitions.ts
 *   - 工具执行器    → tools/rag.ts · tools/cards.ts
 *   - 子 Agent 管线 → subagents.ts
 *   - 辅助函数      → helpers.ts
 *
 * 三条核心不变量（改动时务必保持）：
 *   1. **单工具/轮**：一轮只执行一个 tool_call，其余补 deferred 响应
 *   2. **assistant→tool 配对**：任何退出路径都要 flushPendingToolResponses()
 *   3. **HITL 唯一阻塞点**：只有 await waitUserAnswer 的地方会挂起
 */

import { TAROT_CARDS, getCardById } from "../tarot-cards";
import { buildCardKnowledge } from "../rag-engine";
import { buildFollowupPrompt, PROMPT_VERSION } from "../prompts";
import * as db from "../db";
import { persistMemory } from "../memory";
import { rewriteQueryLocal } from "../query-rewrite";
import { buildProviders, pickProvider, type LLMProvider } from "../llm-providers";
import { callLLM, type CallResult } from "./llm";
import { waitUserAnswer, isHitlGone, nudgeText } from "./hitl";
import { markSessionDirty, snapshotSession } from "./session";
import { toolsForMode, ORACLE_TOOLS } from "./tools/definitions";
import { execRagSearch, prefetchForCard, ragBudgetFor } from "./tools/rag";
import { execDrawCards } from "./tools/cards";
import { runAnalyst, runWriter, runReviewer, type ReviewResult } from "./subagents";
import { generateEcho } from "./echo";
import { runLocalFallback } from "./fallback";
import { clearTruncated } from "./truncation";
import { modeProfile } from "./divination-mode";
import {
  canEnter, advancePhase, RITUAL_PHASE_LABEL, completedPhases, TOOL_PHASE_REQUIREMENT,
} from "./ritual-machine";
import {
  extractEmotionTags, suggestPersonaByEmotion, extractBranchesFromPrompt,
  buildFinalReading, ensureCardSlot, compressRagResult, trimHistory,
  buildSystemPrompt, buildPlanSteps,
} from "./helpers";
import type { AgentEvent, AgentSession, DrawnCard } from "./types";

/**
 * 辅助性写库失败时的记录（P3-⑦：静默吞异常）
 *
 * ⚠️ 为什么这些 catch 不阻断主流程（保持不变）：
 *   记 prompt 版本、落重写归因、写快照 —— 都是**辅助**操作。
 *   它们的失败不该让用户看到"解读失败"（正文已经生成好了）。
 *
 * ⚠️ 但原来是**完全无痕**的 catch（注释里写着 ignore）：
 *   排障时无法区分"没发生过"和"发生了但被吞了"。
 *   降级路径的标注原则（"宁可标注，不要静默消失"）同样适用于这里。
 *
 * ⚠️ 为什么用 console.debug 而不是 console.error：
 *   console.error 会在生产日志里刷屏（这类失败虽罕见但会累积）；
 *   debug 级足够排障时打开，且不掩盖真正的错误。
 */
function dbLog(what: string, e: unknown): void {
  console.debug(
    `[supervisor] ${what}（不影响主流程）:`,
    e instanceof Error ? e.message : String(e)
  );
}

/** delta 合批发送：按 ~36 字符切块（SSE JSON 信封 ~40 字节，
 *  6 字符净荷的信封开销是净荷 2 倍+，长正文事件数是必要值 5~10 倍）。
 *  36 字符在打字机观感与事件数之间取平衡（约 1.5 行文字/事件）。 */
function* chunkDelta(text: string): Generator<{ type: "delta"; delta: string }> {
  const SIZE = 36;
  for (let i = 0; i < text.length; i += SIZE) {
    yield { type: "delta", delta: text.slice(i, i + SIZE) };
  }
}
export async function* runAgent(
  session: AgentSession,
  question: string,
  opts?: { followup?: string }
): AsyncGenerator<AgentEvent> {
  /**
   * ⚠️ 2026-11-04 D 方向：**神谕模式**标志。
   *
   * ⚠️ 为什么必须在**函数最开头**取（而不是在用到它的地方才取）：
   *   它被用在 3 个地方（开场白 / 工具集 / 轮次上限 / 降级路径），
   *   其中开场白在轮次上限**之前**。
   *   → 统一在这里取一次，全函数复用（避免"两处判断不一致"的经典 bug）。
   */
  const oracleMode = session.kind === "oracle";
  /**
   * ⚠️⚠️ P2-⑩（第二轮优化分析 2026-11 ⑩）：**busy 的所有权归路由层**。
   *
   * ⚠️ 原来的问题：busy 标志有**两个写入点**：
   *   ① 路由层 `tryAcquireSession`（原子占用）
   *   ② 这里 `session.busy = true`（重复占用）
   *   → 所有权不唯一 → **释放时机不确定**：
   *      supervisor 的 finally 释放了，路由层的 finally 又释放一次（幂等，无害），
   *      但反过来"路由已释放、supervisor 还在跑"的窗口就存在了。
   *
   * ⚠️ 修法：这里**不再写** busy —— 占用与释放都只在 `tryAcquireSession` /
   *   `releaseSession`（session.ts）这一对里发生。
   * ⚠️ 这里的 `session.busy = true` 曾是"兜底设置"，
   *   但 runAgent **只有一个调用点**（api/interpret 路由），而那个路由
   *   已经在入口做了原子占用 —— 所以这里确实是纯粹的重复。
   */
  try {
  // provider 选择：会话内粘住上次成功的（风格一致），失败自动切换
  const all = buildProviders();
  if (all.length === 0) {
    yield* runLocalFallback(session, question);
    return;
  }
  // 会话粘住的 provider（首次取健康的第一个）
  const sticky = (session as unknown as { __provider?: LLMProvider }).__provider;
  let config: LLMProvider | null = pickProvider(sticky) ?? all[0];
  (session as unknown as { __provider?: LLMProvider }).__provider = config;

  yield { type: "session", sessionId: session.id };

  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: buildSystemPrompt(session) });
    /**
     * ⚠️ 2026-11-04 D 方向：神谕的开场白不是"我想占卜"（那会让模型以为要走仪式）。
     *   神谕是"用户在问一件事"。
     */
    session.messages.push({
      role: "user",
      content: oracleMode ? question : `我想占卜：${question}`,
    });
    /**
     * ⚠️ P2-⑪（第二轮优化分析 2026-11 ⑪）：**原来这里写了一次 PROMPT_VERSION**，
     *   紧接着下面又写 `${PROMPT_VERSION}/${agentMode}` → 前者被**完全覆盖**。
     *   → 白写一次 DB（多一次 UPDATE），而且版本口径可能错
     *   （如果两次写入之间有并发读，会读到不带 agentMode 的版本）。
     *   → 修法：只在**唯一**的位置记录版本（下面 agentMode 确定之后那处）。
     *   ⚠️ 这里**不能删掉记录动作** —— 否则 prompt 版本对比就失效了。
     */
  } else if (opts?.followup) {
    session.messages.push({ role: "user", content: `（追问）${opts.followup}` });
    session.messages.push({
      role: "system",
      content: buildFollowupPrompt({
        // 人格声线：追问回答与正式解读同一人格（此前是裸模型声线，割裂感明显）
        personaStyle: session.persona.stylePrompt,
        personaName: session.persona.name,
        // P2.1：情绪档案——追问也记得用户的情绪
        emotionTags: session.emotionTags,
        // 牌面知识常驻：追问时模型手里要有牌意原文，防止凭记忆编造
        cardKnowledge: buildCardKnowledge(session.drawnCards),
        // 检索摘要：压缩版（牌名+字段），不占太多 token
        ragDigest: session.ragHits.length
          ? session.ragHits.map((h) => `${h.cardNameZh}·${h.field === "upright" ? "正位" : h.field === "reversed" ? "逆位" : h.field === "keywords" ? "关键词" : "叙事"}: ${h.snippet.slice(0, 40)}`).slice(0, 6).join("\n")
          : "（未检索）",
      }),
    });
  }

  yield {
    type: "phase",
    phase: "analyze",
    label: oracleMode
      ? `${session.persona.emoji} ${session.persona.name}在听你说…`
      : `${session.persona.emoji} ${session.persona.name}开始凝听你的问题…`,
  };

  /* ---- 方向⑤：Plan-Execute 模式（AGENT_MODE=plan）----
   * 与默认 ReAct 的差异：进入工具循环前先让 supervisor 产出一份显式计划
   * （步骤清单），作为系统提示注入后续所有轮次。收益：
   * 1. 长流程（10+ 轮）不迷路——计划是"地图"，每轮决策对照计划推进
   * 2. 用户可见"占卜仪轨路线图"（前端 plan 事件渲染），HITL 等待有预期
   * 3. 落库 agent_mode 便于 A/B 对比轮次/token 差异（面试数据点）
   * 计划生成失败（LLM 异常）静默降级回 ReAct——降级不删是底线。 */
  const agentMode = process.env.AGENT_MODE === "plan" ? "plan" : "react";
  session.agentMode = agentMode;
  try { db.updateSessionPromptVersion(session.id, `${PROMPT_VERSION}/${agentMode}`); } catch (e) { dbLog("记录 prompt 版本失败", e); }
  /**
   * ⚠️ 2026-11-04 D 方向：神谕**不做** Plan-Execute。
   *   计划是"占卜仪轨路线图"（承约→呼召→选牌…）——
   *   神谕没有仪轨，注入计划只会让模型去规划不存在的步骤。
   */
  const planSteps = agentMode === "plan" && !oracleMode ? await buildPlanSteps(config, session) : null;
  if (planSteps && planSteps.length >= 3) {
    session.plan = planSteps;
    // 计划注入历史（后续每轮 supervisor 都看得到，作为"地图"对照推进）
    session.messages.push({
      role: "system",
      content: `【仪轨计划】按以下步骤推进，每完成一步对照清单；步骤顺序可依用户回答微调，但不得跳过抽牌与逐张解读：\n${planSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    });
    yield { type: "plan", plan: planSteps };
    yield { type: "phase", phase: "analyze", label: `仪轨已定：${planSteps.length} 步（Plan-Execute 模式）` };
  }

  /**
   * ⚠️ P2-⑭（第二轮优化分析 2026-11 ⑭）：轮次上限**按牌数动态计算**。
   *
   * ⚠️ 原来固定 22 —— 但仪式需要的轮次随牌数变化：
   *   承约1 + 呼召1 + 选牌1 + 检索2 + (翻牌+解读)×N + 综合1 + 收束1
   *   → N=3 时约 14 轮，N=5 时就接近 20 轮。
   * ⚠️ 实测：`max_rounds` 失败的会话平均 **19.0 次工具调用**
   *   —— 说明模型经常撞墙（不是模型笨，是预算给少了）。
   *
   * ⚠️ 修法：`牌数 × 2 + 固定 8`（固定部分覆盖承约/呼召/选牌/检索/综合/收束）。
   * ⚠️ env 覆盖仍然优先（运维需要固定值时用它），且下限不低于原来的 22
   *   —— 宁可多给一点预算，也不要让一场占卜因为轮次不够而失败。
   */
  const BASE_ROUNDS = Number(process.env.MAX_ROUNDS) || 22;
  const cardCount = Math.max(1, session.drawnCards?.length ?? 3);
  /**
   * ⚠️ 2026-11-04 D 方向：**神谕模式**的轮次上限。
   *
   * ⚠️ 神谕是"问一句、答一句"——不需要仪式流程 → 轮次少得多。
   *   实测：一次牌义问答通常 2~4 轮（检索 + 回答 + 可能追问）。
   * ⚠️ 上限给 8 轮：够处理"检索 → 回答 → 澄清 → 再回答"的节奏，
   *   又能防止模型绕圈。
   */
  const modeProfile_ = modeProfile(session.mode ?? "deep");
  const MAX_ROUNDS = oracleMode
    ? 8
    : Math.max(
        modeProfile_.maxRounds,
        cardCount * 2 + 8,
        // ⚠️ 深度模式保持旧行为（不低于 22）
        session.mode === "quick" ? 0 : BASE_ROUNDS
      );
  let round = 0;
  // 模型跳过工具直接回答的纠偏计数（首答模式防行为漂移）
  let noToolRetries = 0;
  // 待补齐响应的 tool_call（见下方 extraTools 处理）
  let pendingToolResponses: Array<{ id: string; name: string }> = [];

  /**
   * 补齐被跳过的 tool_call 响应（保持 assistant→tool 配对完整）。
   * 本轮只执行一个 tool_call，其余的必须也有对应的 tool 消息，
   * 否则 OpenAI 兼容协议错位："tool call result does not follow tool call" (400)。
   * 必须在**每次退出前**调用（含 return / 异常路径）。
   */
  const flushPendingToolResponses = () => {
    for (const skipped of pendingToolResponses) {
      session.messages.push({
        role: "tool",
        tool_call_id: skipped.id,
        content: JSON.stringify({
          deferred: true,
          hint: `「${skipped.name}」本轮未执行——一次只做一个动作。请在下一轮单独调用它。`,
        }),
      });
    }
    pendingToolResponses = [];
  };

  /**
   * 待插入的 user 备注（continue/节奏控制等）。
   *
   * ⚠️ 为什么不能在工具循环尾部直接 push user：
   * 单工具/轮守卫下，模型并行发的 extra tool_calls 会 deferred 到下一轮开头
   * flush。若 continue 的 user 先 push，序列变成
   *   assistant(tool_calls=[interpret,reveal]) → tool(interpret) → user(继续) → tool(deferred reveal)
   * ——tool 响应被 user 隔断，MiniMax 严格协议直接 400
   * "tool call result does not follow tool call"（实测 15:29 复现场）。
   * 暂存到轮首、在 flushPendingToolResponses 之后插入，位置天然安全。
   */
  const pendingUserNotes: string[] = [];
  const flushPendingUserNotes = () => {
    for (const note of pendingUserNotes) {
      session.messages.push({ role: "user", content: note });
    }
    pendingUserNotes.length = 0;
  };

  /**
   * P1-③：待完成的投机预检索。
   * 翻牌瞬间发起（牌名已知），在**下一轮开始时** await ——
   * 检索耗时被藏进"上一轮工具执行 + 模型思考"的时间里。
   */
  let pendingPrefetch: Promise<void> | null = null;

  /**
   * P1-⑧：HITL 等待期间产生的**分级提醒队列**。
   *
   * ⚠️ 为什么需要队列（生成器不能在 await 期间 yield）：
   *    提醒是在 `waitUserAnswer` 内部的 setTimeout 回调里触发的，
   *    而那个回调运行在 Promise 微任务里 —— 生成器正卡在 await 上，
   *    **没有任何办法从回调里把事件 yield 出去**。
   *    解决办法：回调只往队列里塞事件，等等待结束、生成器恢复控制权后，
   *    在**下一轮循环顶部**把队列 flush 出去。
   *
   *    代价：提醒会延后到"用户应答之后"才发出 ——
   *    但这仍然有价值：它告诉前端"刚才那段时间用户在走神"，
   *    前端可以据此显示"占卜师等了你 42 秒"。
   *    真正需要"实时"提醒的场景（如倒计时）应该走独立通道。
   */
  const pendingNudges: AgentEvent[] = [];
  /**
   * P2-⑪：本次 LLM 调用因限速而等待的毫秒数（0 = 没等）
   * ⚠️ 为什么用变量而不是直接入队：
   *    限速通知发生在 LLM 调用**之前**（acquireSlot 里），
   *    那时生成器正卡在 await callLLM 上 —— 无法 yield。
   *    所以先记下来，等这一轮结束、生成器恢复控制权后再补发事件。
   */
  let pendingRateLimitMs = 0;
  /** 生成 nudge 事件的工厂（避免各处重复拼文案） */
  const makeNudge = (level: 1 | 2, kind: "flip" | "contract" | "invocation" | "card_confirm" | "closing" | "clarify" | "crossroads" | undefined) =>
    ({ type: "nudge", nudge: { level, text: nudgeText(level, kind), kind } }) as AgentEvent;

  // 看门狗：**活跃处理时间**上限（默认 8 分钟）。
  // ⚠️ 只累计 Agent 实际工作的时间（LLM 调用 + 工具执行），
  // HITL 等用户思考的时间不计——9 次交互每次 1 分钟就超的旧逻辑
  // 会让慢用户在最后一次应答后被"超时中止"前功尽弃。
  // waitUserAnswer 内部负责 HITL 等待（5 分钟无应答单独超时）。
  const ACTIVE_BUDGET_MS = Number(process.env.SESSION_DEADLINE_MS) || 8 * 60 * 1000;
  let activeMs = 0;
  let roundStartClock = Date.now();
  /** HITL 等待期间的活跃计时控制（deadline 不计用户思考时间） */
  const hitlClock = {
    pause: () => { activeMs += Date.now() - roundStartClock; },
    resume: () => { roundStartClock = Date.now(); },
  };

  // try/finally：无论从哪条路径退出（正常 done / 错误 / 超时），
  // 都要补齐被跳过的 tool_call 响应，否则会话历史里的 tool_call_id 未配对，
  // 下一次追问时 MiniMax 会直接返回 400 "tool call result does not follow tool call"。
  try {
  while (round < MAX_ROUNDS) {
    // 补齐上一轮被跳过的 tool_call 响应（必须最先——assistant→tool 配对优先）
    flushPendingToolResponses();
    // 插入节奏控制备注（continue 等）——在 deferred tool 响应之后，位置安全
    flushPendingUserNotes();

    // ---- P1-⑧：flush HITL 分级提醒 ----
    // ⚠️ 必须在循环顶部（生成器已恢复控制权）—— 提醒是在 await 期间的
    //    setTimeout 回调里产生的，那时无法 yield。
    for (const n of pendingNudges) yield n;
    pendingNudges.length = 0;

    // ---- 插入暂存的插话（方案 C）----
    // 位置已安全（上一轮 assistant→tool 已配对完成）
    if (session.pendingInterjections.length > 0) {
      for (const t of session.pendingInterjections) {
        session.messages.push({ role: "user", content: `（用户补充说明：${t}）` });
      }
      session.pendingInterjections = [];
    }

    // 看门狗检查：活跃处理超时 → 放弃并明确标记
    if (activeMs + (Date.now() - roundStartClock) > ACTIVE_BUDGET_MS) {
      yield { type: "error", error: "占卜耗时超过上限，已中止（可在观测面板查看）" };
      db.failSession(session.id, "deadline_exceeded");
      return;
    }
    round++;
    const roundStart = Date.now();
    roundStartClock = Date.now();
    let roundPromptTokens: number | undefined;
    const roundToolNames: string[] = [];
    let decision: CallResult;
    try {
      // ---- P1-③：等待投机预检索完成 ----
      // 翻牌瞬间发起的预检索（牌名已知）在这里被 await ——
      // 它的耗时被藏进"模型思考 + 上一轮工具执行"的时间里，
      // 下一轮 rag_search 直接命中缓存，省掉一次完整检索（~100~400ms + ONNX 推理）。
      // ⚠️ 不能无脑等：预检索失败/超时不能拖住主线 → 加超时保护。
      if (pendingPrefetch) {
        const p = pendingPrefetch;
        pendingPrefetch = null;
        await Promise.race([
          p.catch(() => { /* 预检索失败不影响主线 */ }),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
      // 历史裁剪：压缩早期 tool 观察结果，降低每轮 prompt token
      let trimmed = trimHistory(session.messages);
      // ---- 临期强制收尾（防 max_rounds 死循环撞墙）----
      // 轮次接近上限时注入"必须立即收尾"指令（只注入到本次调用，不污染会话历史）
      // 注意：逐张解读模式下不能过早催促——还有牌没讲完时催促会导致模型乱来。
      /**
       * ⚠️ 2026-11-04 双模式：快速模式的流程更短，催促点必须**提前**。
       *
       * ⚠️ 实测踩到的坑：原来 `Math.max(10, MAX_ROUNDS - 6)` 的下限是 10。
       *   快速模式 MAX_ROUNDS=14 → LATE_ROUND=10，
       *   但流程需要 11 轮（10 次工具 + 1 次收尾）→ **在第 14 轮撞墙**，
       *   而且撞墙时 `perCardPending` 为 true → 催促指令根本没注入 → 模型不知道要收尾。
       *
       * ⚠️ 修法：下限按模式走 —— 快速模式的下限是 6（它的正常流程只需 ~6 轮）。
       */
      const LATE_ROUND =
        session.mode === "quick"
          ? Math.max(6, MAX_ROUNDS - 4)
          : Math.max(10, MAX_ROUNDS - 6); // 留 6 轮缓冲
      const perCardPending = session.cardReadings.filter((r) => r.reading).length < session.drawnCards.length;
      /**
       * ⚠️ 2026-11-04：催促条件也要看模式 ——
       *   快速模式下"还有牌没讲"不代表还有**多轮**要跑
       *   （一张一次讲完 = 1 轮），所以不能因为 perCardPending 就一直不催促。
       */
      const needWrapUp =
        (round >= LATE_ROUND || session.ragCallCount > ragBudgetFor(session)) &&
        (session.mode === "quick" ? round >= LATE_ROUND + 2 : !perCardPending);
      // ---- 检索工具动态下架（防"预算拒绝后无限重试"死循环）----
      // 实测：预算耗尽后模型仍连撞 16 次 rag_search 直到 deadline。
      // 工具响应里的"不要再检索"劝不住它——必须在下一轮直接不给这个工具。
      // ⚠️ 与 execRagSearch 的拦截条件保持一致（>= 而非 >）：
      //    第 3 次检索成功后 ragCallCount=3，第 4 次起被拦截（count 不再增长），
      //    所以下架判定必须用 >=，否则永远差一次不触发。
      // ⚠️ 2026-11-04 双模式：预算按模式（快速模式 2 次）—— 见 ragBudgetFor
      // ⚠️ 2026-11-04 双模式：工具集按模式取
      //   快速模式用 QUICK_MODE_TOOLS —— interpret_card 被换成 interpret_all_cards
      //   （给模型"没有单张选项" → 它才会一次讲完，见 tools/definitions.ts 的说明）
      // ⚠️ 2026-11-04 D 方向：神谕模式用 ORACLE_TOOLS
      //   —— 从**能力层**禁用抽牌类工具（prompt 说"别抽牌"只是建议，工具才是能力）
      const modeTools = oracleMode
        ? ORACLE_TOOLS
        : toolsForMode(session.mode ?? "deep");
      const ragBanned = session.ragCallCount >= ragBudgetFor(session);
      const availableTools = ragBanned
        ? modeTools.filter((t) => t.function.name !== "rag_search")
        : modeTools;
      if (needWrapUp && session.drawnCards.length > 0) {
        /**
         * ⚠️ 2026-11-04：催促内容必须**区分状态** ——
         *   牌还没讲完时催"立即 write_reading"会被守卫拦住（write_reading
         *   要求所有牌都有解读正文）→ 模型被反复弹回 → 死循环。
         */
        const revealedCount = session.cardReadings.filter((r) => r.reveal).length;
        const allRevealed = revealedCount >= session.drawnCards.length;
        const wrapUpText =
          session.mode === "quick"
            ? allRevealed
              ? "牌都已揭示但还没讲完 —— 请**立刻**用一次 interpret_card 传 card_indexes + readings 把所有牌一次讲完，下一轮调用 write_reading。"
              : "请**立刻**用一次 reveal_card 传 card_indexes 把所有牌一次揭示，再用一次 interpret_card 一次讲完，下一轮调用 write_reading。"
            : "本轮必须调用 write_reading 启动解读管线，不得再调用任何检索或提问工具。";
        trimmed = [
          ...trimmed,
          {
            role: "system" as const,
            content: `⚠️ 流程即将到达轮次上限（当前第 ${round} 轮，检索已 ${session.ragCallCount} 次）。你手里已有 ${session.drawnCards.length} 张牌与检索结果，信息完全足够。${wrapUpText}`,
          },
        ];
      } else if (ragBanned) {
        // 检索超预算：不管牌是否讲完，禁检索（讲完的催收尾，没讲完的继续讲牌）
        const nextStep = perCardPending
          ? "继续按节奏 reveal_card/interpret_card 逐张讲牌，全部讲完后调用 write_reading"
          : "立即调用 write_reading 启动解读管线";
        trimmed = [
          ...trimmed,
          {
            role: "system" as const,
            content: `⚠️ 检索预算已用尽（${session.ragCallCount} 次），rag_search 已下架。累计 ${session.ragHits.length} 条资料完全足够。${nextStep}。`,
          },
        ];
      }
      decision = await callLLM(
        config, trimmed, availableTools, session.id, "supervisor",
        // P2-⑪：限速等待 → 推一个 phase 事件告诉用户"正在控制请求节奏"
        // （与 nudge 同样的约束：回调里不能 yield，只能入队）
        (waitMs) => {
          pendingRateLimitMs = waitMs;
        }
      );
      roundPromptTokens = decision.usage?.prompt;
      // P2-⑪：补发"限速等待"提示（此时生成器已恢复控制权，可以 yield 了）
      // ⚠️ 为什么必须告知用户：限速等待（最长 20 秒）与"模型慢"是两回事 ——
      //    前者是**我们主动控制节奏**（为了不触发服务端 429），
      //    后者是模型本身慢。不说清楚，用户只会觉得"这产品好慢"。
      if (pendingRateLimitMs > 0) {
        yield {
          type: "phase",
          phase: "analyze",
          label: `为避免触发服务端限流，已放慢请求节奏（等待 ${Math.round(pendingRateLimitMs / 1000)} 秒）`,
        };
        pendingRateLimitMs = 0;
      }
      // failover 生效时更新会话粘住的 provider（保持后续风格一致）——按名称比较，避免对象实例误判
      const used = buildProviders().find((p) => p.name === decision.provider);
      if (used && used.name !== config?.name) {
        config = used;
        (session as unknown as { __provider?: LLMProvider }).__provider = used;
        yield { type: "phase", phase: "analyze", label: `主模型连接不畅，已切换备用模型（${used.name}）` };
      }
    } catch (e) {
      // ⚠️ 所有 provider 都失败时降级到本地剧本引擎（降级不删是项目底线）：
      //    余额耗尽（402）/ 鉴权失败（401/403）/ 全部超时 —— 这些情况
      //    下死等只会让用户看到报错。本地剧本跑完整场仪式（质量不如
      //    真模型，但"白屏报错"更不可接受）。
      //    首答模式才降级；追问模式已经聊了一半，静默降级会答非所问。
      // ⚠️ 2026-11-04 D 方向：神谕**不能**用本地降级剧本 ——
      //   runLocalFallback 跑的是"完整占卜仪式"（承约→呼召→抽牌…），
      //   对神谕来说完全跑偏（用户问的是一句牌义，却收到一场占卜）。
      //   → 神谕降级为"直答"：把问题原样交给本地剧本的解读能力不可行，
      //     所以直接报错（用户看到"暂时失联"，比收到无关内容好）。
      const isFollowup = opts?.followup !== undefined && session.messages.length > 2;
      if (!oracleMode && !isFollowup && session.drawnCards.length === 0) {
        yield {
          type: "phase",
          phase: "analyze",
          label: "远端模型不可用，已切换本地引擎（占卜质量可能下降）…",
        };
        yield* runLocalFallback(session, question);
        return;
      }
      // ⚠️ P3-⑫：不把内部错误原文发给客户端
      //    llm.ts 抛的是 `LLM 调用失败(429): {上游原始响应体}` ——
      //    里面可能含上游网关的内部细节（URL、错误码、甚至 key 前缀）。
      //    内部细节进 console.error（排障用），用户只看到可读文案。
      console.error("[supervisor] LLM 调用失败:", e);
      yield { type: "error", error: "占卜师暂时失联，请稍后重试" };
      db.failSession(session.id, "llm_error");
      return;
    }
    // reasoning 会下发给浏览器（过程细节面板）。
    // ⚠️ 关于"防剧透"的边界（已与需求方确认）：
    //    本项目保护的是**牌面视觉** —— 牌阵面板里未翻开的牌显示牌背 + ？
    //    （牌面图片与牌名在 card_reveal 时才补上）。
    //    模型自己生成的文字（思考链/正文）里出现牌名**不额外拦截**：
    //    解读本身就是要说"你抽到的是愚者"，拦掉反而破坏内容。
    if (decision.reasoning) yield { type: "reasoning", reasoning: decision.reasoning };
    // 决策消息原样推入历史（保留全部 tool_calls，保证 assistant→tool 配对完整）
    session.messages.push(decision.message);

    // ---- P1.2：决策附带文本作为对话回应流出 ----
    // supervisor 决策时常带 content（"嗯，我听到了，你其实很在意…"），
    // 此前被丢弃——用户答完话得到死寂。现在流出来，占卜师"每步有回应"。
    //
    // ⚠️ 但当本轮同时要发起 HITL 交互（ask_user/fate_crossroads/选牌）时**不流出**：
    //    模型的 content 往往是"岔路口叙述"（"你打算怎么走？"），
    //    若先流出再弹选项面板，用户会看到一段像提问又没选项的正文——反而更困惑。
    const toolCalls = decision.message.tool_calls;
    const hasHitl = (toolCalls ?? []).some((tc) =>
      ["ask_user", "offer_card_selection", "fate_crossroads"].includes(tc.function.name)
    );
    if (decision.message.content && session.messages.length > 3 && !hasHitl) {
      const intro = decision.message.content.trim();
      if (intro) {
        for (const evt of chunkDelta(intro)) yield evt;
        // 换行分隔，与后续解读正文区分
        yield { type: "delta", delta: "\n\n" };
      }
    }

    if (!toolCalls || toolCalls.length === 0) {      // ---- 无工具调用分支 ----
      // 追问模式：纯文本回答是正常路径
      const isFollowup = opts?.followup !== undefined && session.messages.length > 2;
      if (isFollowup) {
        const text = decision.message.content;
        if (text) {
          for (const evt of chunkDelta(text)) yield evt;
          // ⚠️ 追加而非覆盖：updateSessionReading 整体替换 reading 字段，
          // 会把原逐张正文替换成本次追问回答（分享卡/dashboard 从此只见追问）
          const prev = db.getSessionReading?.(session.id)?.reading ?? session.reading ?? "";
          db.updateSessionReading(session.id, prev ? `${prev}\n\n【追问】${text}` : text);
        }
        yield { type: "done" };
        session.finished = true;
        return;
      }

      /**
       * ⚠️⚠️ 2026-11-04 D 方向：**神谕模式** —— 纯文本回答就是**完成**。
       *
       * ⚠️ 为什么必须在这里就结束（而不是走下面的"首答纠偏"）：
       *   首答纠偏的逻辑是"模型没抽牌就回答 = 无效占卜"——
       *   那**只对占卜成立**。神谕本来就不抽牌，
       *   若走纠偏路径，模型会被反复要求"去抽牌"（而神谕没有抽牌工具）
       *   → 死循环 → 用户看到"占卜师陷入沉思"。
       */
      if (oracleMode) {
        const text = decision.message.content;
        if (text) {
          for (const evt of chunkDelta(text)) yield evt;
          db.updateSessionReading(session.id, text);
        }
        yield { type: "done" };
        session.finished = true;
        return;
      }

      // 首答模式：模型跳过工具直接回答 = 无效占卜（没有牌面依据）。
      // 不放行——注入纠偏消息强制其走工具流程，最多重试 2 次（防模型行为漂移）。
      noToolRetries++;
      if (noToolRetries <= 2) {
        yield {
          type: "phase",
          phase: "analyze",
          label: "占卜师整理仪轨（未开牌，重新进入流程）…",
        };
        session.messages.push({
          role: "user",
          content: "⚠️ 你还没有抽取塔罗牌，不能直接给出解读。请立即调用工具：先 offer_card_selection 或 draw_cards 抽牌（若问题仍模糊可先 ask_user 澄清一次）。不要输出任何文本解释。",
        });
        continue;
      }
      // 两次纠偏仍不调工具：接受文本但标注（极小概率）
      const text = decision.message.content;
      if (text) {
        for (const evt of chunkDelta(text)) yield evt;
        db.updateSessionReading(session.id, text);
      }
      yield { type: "done" };
      session.finished = true;
      return;
    }
    noToolRetries = 0;

    // ⚠️ 一轮只执行一个工具调用
    // 真实占卜师的节奏是"做一个动作 → 看用户反应 → 再做下一个"。
    // 若一轮里执行多个 HITL 工具（如 3 个 interpret_card），
    // 用户会看到"问都没问就连续讲了三张牌"——退化成一次性生成。
    // 多余的 tool_calls 直接丢弃。提示信息写进**当前 tool 的返回内容**里
    // （不能插 user 消息：那会打断 assistant→tool 的配对，
    //  导致 OpenAI 兼容协议错位 "tool call result does not follow tool call"）。
    const extraTools = toolCalls.slice(1);
    // 记录待补齐的 tool_call（本轮结束后统一补响应，保持协议配对）
    pendingToolResponses = extraTools.map((t) => ({ id: t.id, name: t.function.name }));

    for (const tc of toolCalls.slice(0, 1)) {
      const name = tc.function.name;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* 空参 */ }
      const t0 = Date.now();
      session.toolSeq++;
      const seq = session.toolSeq;
      // HITL 通用变量（承约/呼召/澄清/选牌/岔路共用）
      let askPrompt = "";
      let options: string[] | undefined;

      /* ================================================================
       * 仪式守卫（P2-⑨）：**统一入口**，覆盖全部仪式工具
       *
       * ⚠️ 为什么放在这里（而不是每个分支里各写一份）：
       *   审计实测：守卫只覆盖了 2 个工具（offer_card_selection / draw_cards），
       *   其余 6 个仪式工具（establish_contract / invoke_three_questions /
       *   reveal_card / interpret_card / write_reading / close_reading）
       *   **完全没有前置检查** —— 模型可以：
       *     · 不承约直接 reveal_card（跳步）
       *     · 不抽牌直接 interpret_card（解读不存在的牌）
       *     · 不逐张讲完直接 write_reading（综合没依据）
       *   实测证据：32/34 条 eval 用例的 contract/invocation/percard/closing 全缺。
       *
       * ⚠️ 为什么统一在分发前拦截（单一事实源）：
       *   分支里各写一份 → 加新工具时必然漏（这正是 bug 的成因）。
       *   在分发前统一查表 → 新工具只要在表里登记就自动受保护。
       *
       * ⚠️ 表的语义：每个工具声明"它需要哪些阶段已完成"。
       *   判定交给 ritual-machine.canEnter()（同一套规则，不重复实现）。
       * ================================================================ */
      {
        const required = TOOL_PHASE_REQUIREMENT[name];
        /**
         * ⚠️ 2026-11-04 快速模式：呼召工具**本身**就该被拦住。
         *
         * ⚠️ 为什么不能只靠 canEnter 的前置过滤：
         *   canEnter 只检查"目标阶段的前置是否完成"——
         *   快速模式里 invocation 不在 requiredPhases 里 →
         *   invoke_three_questions 的 required="invocation" 会因为
         *   "前置（contract）已完成"而**放行**（它检查的是 invocation 的前置，
         *   不是 invocation 本身）。
         *   → 必须在这里显式拦：这个模式不需要这一步。
         */
        const mode = session.mode ?? "deep";
        if (mode === "quick" && name === "invoke_three_questions") {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "快速模式不需要三问呼召",
              hint: "现在是「快速一问」模式 —— 不要调用 invoke_three_questions。请直接调用 offer_card_selection 让用户选牌。",
            }),
          });
          roundToolNames.push(`${name}(拦截)`);
          db.logToolCall(session.id, seq, "supervisor", name, args, "守卫拦截：快速模式不需要呼召", Date.now() - t0);
          continue;
        }
        if (required) {
          const guard = canEnter(
            session.ritualPhase ?? "contract",
            required,
            completedPhases(session),
            { toolName: name },
            mode
          );
          if (!guard.ok) {
            session.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                error: `仪式阶段不符：${name} 需要先完成「${RITUAL_PHASE_LABEL[required]}」`,
                missing: guard.missing ? RITUAL_PHASE_LABEL[guard.missing] : undefined,
                hint: guard.hint,
              }),
            });
            roundToolNames.push(`${name}(拦截)`);
            db.logToolCall(
              session.id, seq, "supervisor", name, args,
              `守卫拦截：缺「${guard.missing ? RITUAL_PHASE_LABEL[guard.missing] : required}」`,
              Date.now() - t0
            );
            continue;
          }
        }
      }

      /* ---- D：收束 + 收尾追问 ---- */
      if (name === "close_reading") {
        // ⚠️ 守卫：零牌路径绕过（第 1 轮就 close → reading='' 落库 done）
        // close_reading 必须建立在"抽了牌且逐张讲完"之上。
        if (session.drawnCards.length === 0) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "还没有抽牌，不能收束",
              hint: "请先 offer_card_selection / draw_cards 抽牌，再逐张 reveal_card + interpret_card，全部讲完后才能 close_reading。",
            }),
          });
          roundToolNames.push("close_reading(拦截)");
          continue;
        }
        const missingSlots = session.drawnCards.filter((d) => {
          const slot = session.cardReadings.find((r) => r.cardId === d.card.id);
          return !slot?.reading;
        });
        if (missingSlots.length > 0) {
          const missing = missingSlots.map((d) => `第${session.drawnCards.indexOf(d) + 1}张「${d.card.nameZh}」`);
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "还有牌没讲完，不能收束",
              missing,
              hint: `请先对 ${missing.join("、")} 依次 reveal_card + interpret_card，全部讲完后再 close_reading。`,
            }),
          });
          yield { type: "phase", phase: "interpret", label: `还有 ${missing.length} 张牌没讲——继续翻牌` };
          roundToolNames.push("close_reading(拦截)");
          continue;
        }
        const closing = String(args.closing || "").trim();
        const question = String(args.question || "这三段里，哪一段最贴近你现在的状态？").trim();
        // P1-⑩：推进阶段（综合 → 收束）
        session.ritualPhase = advancePhase(session.id, session.ritualPhase ?? "synthesis", "closing");
        let cOptions = Array.isArray(args.options)
          ? (args.options as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (cOptions.length < 2) {
          cOptions = session.drawnCards.map((d, i) => {
            const pos = session.drawnCards.length === 1 ? "核心指引" : (["过去", "当下", "未来"][i] ?? `第${i + 1}张`);
            return `${pos}那段`;
          });
        }
        // 收束语作为正文流出（先建目标条目再流 delta，前端按"收束"标签建命运之卷）
        yield { type: "phase", phase: "interpret", label: "占卜师收束这场占卜…" };
        if (closing) {
          for (const evt of chunkDelta(closing)) yield evt;
          yield { type: "delta", delta: "\n\n" };
        }
        yield { type: "phase", phase: "wait_user", label: "收束——听听你的回响…" };
        // ⚠️ 闸门先就绪再通知（与下方 ask_user 分支同一原则）：
        //    否则客户端抢跑应答会撞 409，应答被丢弃 → 等满 5min HITL 超时。
        const closingWait = waitUserAnswer(session, question, cOptions, "closing", hitlClock, (level, kind) => pendingNudges.push(makeNudge(level, kind)));
        yield {
          type: "ask_user",
          ask: { question, options: cOptions, allowFree: true, prompt: question, kind: "closing" },
        };
        const answer = await closingWait;
        // 超时/断开：以"未回应"收尾落库（不再无限挂起，也不拿哨兵值当用户回答）
        if (isHitlGone(answer)) {
          /**
           * P2-⑦：closing / question 是**模型自己写在 arguments 里**的，
           *   这里只回传**新增信息**（用户的回应）→ 实测重复率从 71% 降到 0。
           */
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ saved: true, userAnswer: "（用户未回应，已收束）" }) });
          const finalReading = buildFinalReading(session);
          db.updateSessionReading(session.id, finalReading);
          const lastReview = (session as unknown as { __lastReview?: ReviewResult | null }).__lastReview ?? null;
          db.finishSession(session.id, lastReview);
          session.finished = true;
          // P1-⑩：推进到终态
          session.ritualPhase = advancePhase(session.id, session.ritualPhase ?? "closing", "done");
          yield { type: "done" };
          return;
        }
        // ⚠️ P2-⑦：closing / question 已在 arguments 里 → 只回传新增信息
        session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ saved: true, userAnswer: answer }) });
        yield { type: "tool", tool: { name, args, resultSummary: `收束完成，用户回应：${answer.slice(0, 40)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `收束｜${answer.slice(0, 50)}`, Date.now() - t0);
        roundToolNames.push(name);

        /**
         * ⚠️⚠️ 回响（2026-11-04 新增）
         *
         * ⚠️ 用户实测报告："综合与收束那里，我每次回答完问题，都是停在那里了…
         *   需要用户有输入的时候，他能接上话…不要让用户停在那里"。
         *
         * ⚠️ 为什么放在这里（用户答完收束问题之后、done 之前）：
         *   此刻情绪轨迹已完整（承约/呼召/确认各环节累积），
         *   三张牌的解读也都在 session.cardReadings 里 ——
         *   **正是生成回响所需的全部素材齐备的时刻**。
         *
         * ⚠️ 回响失败**绝不影响主流程**（generateEcho 内部 catch 返回 null）——
         *   收束照常完成，用户只是少看到一段话。
         */
        const echo = await generateEcho(config, session, answer);
        if (echo) {
          // ⚠️ 作为**正文**流出（走 delta）→ 前端会把它接在收束正文后面，
          //    用户视角是"占卜师接着说了一段"，而不是多出一个 UI 组件。
          yield { type: "phase", phase: "interpret", label: "占卜师留下回响…" };
          for (const evt of chunkDelta(echo)) yield evt;
          yield { type: "delta", delta: "\n\n" };
          db.logTiming(session.id, "echo", 0, echo.slice(0, 60));
          /**
           * ⚠️⚠️ 回响也要并入 session.reading（2026-11-04 修）
           *
           * ⚠️ 为什么必须并入：
           *   `buildFinalReading(session)` 只拼 cardReadings + session.reading ——
           *   回响是**局部变量**，不进 session.reading 的话：
           *     · 落库的正文**不含回响**（实测确认：正文尾部停在牌面解读）
           *     · 分享卡的摘要**不含回响**（分享卡取的是 reading）
           *     · 刷新后看到的正文也**不含回响**
           *   → 用户看到的是"占卜师说了回响，但一刷新就没了"（前后不一致）。
           *
           * ⚠️ 追加而不是覆盖（保持既有正文）。
           */
          session.reading = session.reading ? `${session.reading}\n\n${echo}` : echo;
        }
        // ---- 方向⑤：情绪驱动的人格切换建议 ----
        // 收束点是最自然的"下一次入口"：整场情绪轨迹已完整（emotionTags
        // 在承约/呼召/确认问题各环节累积）。规则：
        //   高焦虑(紧张/焦虑/迷茫/压力) + 当前是"直断导师" → 建议疗愈师
        //   情绪平稳 + 当前是疗愈师 → 建议直断（要真相不要安慰）
        // 只建议不强制：yield 事件给前端渲染，下一场由用户自选。
        const suggest = suggestPersonaByEmotion(session);
        if (suggest) {
          yield { type: "persona_suggest", personaSuggest: suggest };
          db.logTiming(session.id, "persona_suggest", 0, `${session.persona.id} → ${suggest.personaId}: ${suggest.reason}`);
        }
        // 收束完成 → 落库结束
        const finalReading = buildFinalReading(session);
        db.updateSessionReading(session.id, finalReading);
        // 审校结果（若已产生）一并落库
        const lastReview = (session as unknown as { __lastReview?: ReviewResult | null }).__lastReview ?? null;
        db.finishSession(session.id, lastReview);
        session.finished = true;
        // P1-⑩：推进到终态
        session.ritualPhase = advancePhase(session.id, session.ritualPhase ?? "closing", "done");
        yield { type: "done" };
        return;
      }

      /* ---- B1：逐张翻牌（翻牌闸门 → 念牌 → 确认问题）---- */
      if (name === "reveal_card") {
        /**
         * ⚠️ 2026-11-04 快速模式：支持一次揭示**多张**牌。
         *
         * ⚠️ 为什么（实测发现的真实瓶颈）：
         *   快速模式第一次跑出时，工具序列是
         *   reveal_card ×3 + interpret_card ×1 = 4 轮 → 加上检索与前置共 11 轮
         *   → **撞了 max_rounds**（14 轮上限）。
         *   每一次工具调用 = 一轮 LLM 往返 = 一次完整 prompt。
         *   → 揭示多张牌：省 2 轮 ≈ 省 10k tokens ≈ 省 ¥0.16/场。
         *
         * ⚠️ 深度模式完全不用这个参数（行为零变化）。
         */
        const revealIdxs: number[] = Array.isArray(args.card_indexes)
          ? (args.card_indexes as unknown[])
              .map((v) => Number(v))
              .filter((n) => Number.isFinite(n))
              .map((n) => Math.max(0, Math.min(n, session.drawnCards.length - 1)))
          : [];

        if (revealIdxs.length > 0 && !modeProfile(session.mode ?? "deep").perCardGated) {
          /** 快速模式：一次揭示多张（每张仍各自下发 card_reveal） */
          const revealed: string[] = [];
          for (const i of revealIdxs) {
            const d = session.drawnCards[i];
            if (!d) continue;
            const sl = ensureCardSlot(session, i);
            if (sl.reveal) continue; // 幂等：已揭示的不重复
            const posNames = ["过去", "当下", "未来"];
            const pos = session.drawnCards.length === 1 ? "核心指引" : (posNames[i] ?? `第${i + 1}张`);
            const narrative = String(args.narrative ?? "").trim() || d.card.description || "";
            const meaning = String(args.meaning ?? "").trim() || (d.reversed ? d.card.reversed : d.card.upright);
            sl.pos = pos;
            sl.reveal = {
              narrative,
              meaning,
              question: String(args.question ?? "这张牌对你来说，是什么意思？").trim(),
              options: ["是这样", "其实不太像", "我说不上来"],
            };
            sl.flipped = true;
            if (!sl.answer) sl.answer = "（快速模式未逐张确认）";
            (session.flippedCardIdx ??= []).push(i);
            revealed.push(`${pos}·${d.card.nameZh}`);
            yield {
              type: "card_reveal",
              cardReveal: {
                cardIndex: i,
                total: session.drawnCards.length,
                id: d.card.id,
                nameZh: d.card.nameZh,
                image: d.card.image,
                reversed: d.reversed,
                pos,
                narrative,
                meaning,
              },
            };
          }
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ revealed }),
          });
          yield {
            type: "tool",
            tool: { name, args, resultSummary: `揭示 ${revealed.length} 张牌`, durationMs: Date.now() - t0 },
          };
          db.logToolCall(session.id, seq, "supervisor", name, args, `揭示 ${revealed.length} 张牌`, Date.now() - t0);
          roundToolNames.push(name);
          continue;
        }

        const idx = Math.max(0, Math.min(Number(args.card_index) || 0, session.drawnCards.length - 1));
        const drawn = session.drawnCards[idx];
        if (!drawn) {
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "还没有抽牌" }) });
          continue;
        }
        /**
         * ⚠️⚠️ 快速模式（2026-11-04 双模式）：**跳过两道闸门**
         *
         * ⚠️ 为什么快速模式不等用户翻牌、不等确认回答：
         *   HITL 交互次数是"用户感知到的仪式成本"的核心。
         *   深度模式：承约 + 呼召 + 选牌 + 3×(翻牌 + 确认) + 收束 = 10 次交互
         *   快速模式目标：承约 + 选牌 + 收束 = 3 次交互
         *   → 每张牌省下 2 次等待 = 省 6 次 = 用户等待时间从 ~80s 降到 ~45s
         *
         * ⚠️ 保留什么（不能全砍）：
         *   · 牌面叙述仍然下发（card_reveal）—— 用户要看到牌
         *   · 用户仍会亲手选牌（offer_card_selection）—— 那是"选"的仪式感
         *   · confirm 问题仍然生成并存进 slot —— 供后续解读参考
         *     （回答统一为"（快速模式未逐张确认）"）
         */
        const quickMode = !modeProfile(session.mode ?? "deep").perCardGated;

        // ⚠️ 幂等守卫：同一张牌不重复念牌/重问（模型偶发重复调用，
        // 会覆盖用户已给的确认回答）
        const existingSlot = session.cardReadings.find((r) => r.cardId === drawn.card.id);
        if (existingSlot?.reveal && existingSlot.answer && !quickMode) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: `第 ${idx + 1} 张「${drawn.card.nameZh}」已翻过且用户已回答`,
              hint: `请直接 interpret_card(card_index=${idx}) 讲透这张牌，或 reveal_card 下一张未翻的牌。`,
            }),
          });
          roundToolNames.push("reveal_card(拦截)");
          continue;
        }

        /* ---- 逐张翻牌闸门：必须按顺序、且等用户亲手翻开 ----
         * 防跳步：模型偶尔会直接 reveal_card(2) 跳过第 2 张
         * （实测：3 张牌只翻了第 1 张）。已翻牌数 = 当前唯一允许翻的索引。
         */
        const flippedOrder = (session.flippedCardIdx ??= []);
        if (idx !== flippedOrder.length) {
          const already = flippedOrder.map((i) => session.drawnCards[i]?.card.nameZh).filter(Boolean);
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: `第 ${idx + 1} 张还不能翻`,
              hint:
                already.length > 0
                  ? `用户已依次翻开：${already.join("、")}。请先 reveal_card(card_index=${already.length}) —— 用户必须亲手翻开每一张牌。`
                  : `请先 reveal_card(card_index=0)，让用户亲手翻开第一张牌。`,
            }),
          });
          roundToolNames.push("reveal_card(拦截)");
          continue;
        }

        const narrative = String(args.narrative || drawn.card.description || "").trim();
        const meaning = String(args.meaning || (drawn.reversed ? drawn.card.reversed : drawn.card.upright)).trim();
        const question = String(args.question || "这张牌对你来说，是什么意思？").trim();
        let qOptions = Array.isArray(args.options)
          ? (args.options as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (qOptions.length < 2) qOptions = ["是这样", "其实不太像", "我说不上来"];

        const posNames = ["过去", "当下", "未来"];
        const pos = session.drawnCards.length === 1 ? "核心指引" : (posNames[idx] ?? `第${idx + 1}张`);

        /* ---- 快速模式：不等待，直接揭示牌面 ----
         * ⚠️ 与深度模式的差异只有"等不等用户"：
         *   · 深度：翻牌闸门（等用户点牌）→ 确认问题（等用户回答）→ 讲牌
         *   · 快速：直接揭示 → 记为"未逐张确认" → 等模型一次讲完
         * ⚠️ 为什么仍然发 card_reveal：用户必须看到牌（这是占卜的基本体验）。
         */
        if (quickMode) {
          const quickSlot = ensureCardSlot(session, idx);
          quickSlot.pos = pos;
          quickSlot.reveal = { narrative, meaning, question, options: qOptions };
          quickSlot.flipped = true;
          // ⚠️ 快速模式没有逐张确认 → answer 记为占位（让 interpret_card 的守卫通过）
          if (!quickSlot.answer) quickSlot.answer = "（快速模式未逐张确认）";
          (session.flippedCardIdx ??= []).push(idx);
          yield {
            type: "card_reveal",
            cardReveal: {
              cardIndex: idx,
              total: session.drawnCards.length,
              id: drawn.card.id,
              nameZh: drawn.card.nameZh,
              image: drawn.card.image,
              reversed: drawn.reversed,
              pos,
              narrative,
              meaning,
            },
          };
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            // ⚠️ P2-⑦：不回显 narrative/meaning/question（模型已写在 arguments 里）
            content: JSON.stringify({ card: `${pos}·${drawn.card.nameZh}`, revealed: true }),
          });
          yield {
            type: "tool",
            tool: { name, args, resultSummary: `揭示 ${pos}·${drawn.card.nameZh}`, durationMs: Date.now() - t0 },
          };
          db.logToolCall(session.id, seq, "supervisor", name, args, `揭示 ${drawn.card.nameZh}`, Date.now() - t0);
          roundToolNames.push(name);
          continue;
        }

        /* ---- 闸门 1/2：等用户亲手翻牌 ----
         * ⚠️ 牌面内容（narrative/meaning/question）此时**不下发**——
         * 只发 card_flip_ready（索引 + 位置名，无牌面）。
         * 用户点击后前端 POST /api/answer{answer:"翻牌"} 才继续。
         */
        const gateSlot = ensureCardSlot(session, idx);
        gateSlot.pos = pos;
        const flipPrompt = idx === 0
          ? "点开第一张牌"
          : `「${flippedOrder.map((i) => session.drawnCards[i]?.card.nameZh).filter(Boolean).join("、")}」讲完了。点开「${pos}」这张牌`;
        // ⚠️ 翻牌闸门必须**先就绪、再通知前端**：
        //    waitUserAnswer 是在 await 表达式求值时才设置 session.pendingAsk。
        //    若先发 ask_user(flip) / flip_ready 再 await，前端收到"可点"信号时
        //    后端还没在等 → 用户抢跑点击 → /api/answer 409
        //    「当前没有等待回答的问题」。
        //    症状：对话流里的牌点很多次没反应（409 被吞），
        //    而顶部时间线的牌因为用户"看了一会儿才点"反而能翻。
        //
        //    做法：先启动等待（拿到 pendingAsk），**再**发事件 ——
        //    前端的"可点"状态与后端闸门严格对齐，杜绝抢跑。
        const flipWait = waitUserAnswer(session, flipPrompt, undefined, "flip", hitlClock, (level, kind) => pendingNudges.push(makeNudge(level, kind)));
        yield {
          type: "ask_user",
          ask: {
            question: flipPrompt,
            options: undefined,
            allowFree: true,
            prompt: "翻开这张牌",
            kind: "flip",
          },
        };
        yield {
          type: "card_flip_ready",
          cardFlipReady: { cardIndex: idx, total: session.drawnCards.length, pos },
        };
        const flipResult = await flipWait;
        // 翻开（无论用户是点牌还是插话后点牌，都视为这张牌已被翻开）
        flippedOrder.push(idx);
        gateSlot.flipped = true;
        // 方向③：Speculative 预检索——用户点开这张牌的瞬间，牌名已知，
        // 提前触发检索，结果进**跨会话缓存**。
        // ⚠️ P1-③：不再"发后不理"——把 Promise 存起来，下一轮开始时 await
        //    （耗时藏进模型思考时间），下一轮 rag_search 直接命中缓存。
        {
          pendingPrefetch = prefetchForCard(drawn.card.nameZh, session, 5).catch(() => {
            /* 预检索失败不影响主线 */
          });
        }
        // 插话：用户在翻牌闸门里说的话（不是"翻牌"）→ 记入插话，供后续解读引用
        const flipText = flipResult.trim();
        if (flipText && !/^(翻牌|翻开|翻下一张|继续|好的?|嗯|好|翻)/.test(flipText) && !isHitlGone(flipResult)) {
          session.interjections.push(flipText);
          pendingUserNotes.push(`（翻牌间隙补充：${flipText}）`);
        }

        /* ---- 闸门 2/2：牌面此刻才下发 ---- */
        // 落库该张牌的"念牌"内容
        const slot = ensureCardSlot(session, idx);
        slot.reveal = { narrative, meaning, question, options: qOptions };
        slot.pos = pos;

        // 发翻牌事件（前端做 3D 翻牌动画 + 牌面叙述）
        yield {
          type: "card_reveal",
          cardReveal: {
            cardIndex: idx,
            total: session.drawnCards.length,
            id: drawn.card.id,
            nameZh: drawn.card.nameZh,
            image: drawn.card.image,
            reversed: drawn.reversed,
            pos,
            narrative,
            meaning,
          },
        };
        yield {
          type: "phase",
          phase: "wait_user",
          label: `翻到「${pos}·${drawn.card.nameZh}」，请占卜师与你说说话`,
        };
        // 提确认问题（这是 HITL：等用户回答）
        // ⚠️ 闸门先就绪再通知（避免客户端抢跑 409）
        const confirmWait = waitUserAnswer(session, question, qOptions, "card_confirm", hitlClock, (level, kind) => pendingNudges.push(makeNudge(level, kind)));
        yield {
          type: "ask_user",
          ask: { question, options: qOptions, allowFree: true, prompt: question, kind: "card_confirm" },
        };
        const answer = await confirmWait;
        // 超时/断开：以"用户未回应"记录，流程不中断（占卜师按默认情况讲牌）
        if (isHitlGone(answer)) {
          slot.answer = "（用户未回应）";
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            /**
             * P2-⑦（第二轮优化分析 2026-11 ⑦）：**不回显 narrative/meaning/question**。
             * ⚠️ 为什么：这三个字段是**模型自己写在 tool_calls.arguments 里**的，
             *    工具结果再抄一遍 = 纯重复（实测重复率 55%~66%）。
             * ⚠️ 成本放大效应：prompt 是**累积**的 —— 第 k 轮省下的每个字，
             *    后续每一轮都要再省一次。实测单场累计浪费 ≈ 10,078 字 ≈ 4,031 tokens
             *    ≈ 单场 supervisor 消耗的 16%。
             * ⚠️ 只返回**新增信息**：翻了什么牌 + 用户的回答。
             */
            content: JSON.stringify({
              card: `${pos}·${drawn.card.nameZh}`,
              userAnswer: "（用户未回应）",
            }),
          });
          yield { type: "tool", tool: { name, args, resultSummary: `翻牌 ${pos}·${drawn.card.nameZh}（用户未回应）`, durationMs: Date.now() - t0 } };
          db.logToolCall(session.id, seq, "supervisor", name, args, `翻牌 ${drawn.card.nameZh}｜未回应`, Date.now() - t0);
          roundToolNames.push(name);
          continue;
        }
        slot.answer = answer;
        for (const tag of extractEmotionTags(answer)) {
          if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
        }
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          // ⚠️ P2-⑦：同上方 —— 不回显 narrative/meaning/question（模型已写在 arguments 里）
          content: JSON.stringify({
            card: `${pos}·${drawn.card.nameZh}`,
            userAnswer: answer,
          }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `翻牌 ${pos}·${drawn.card.nameZh}，用户回应：${answer.slice(0, 40)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `翻牌 ${drawn.card.nameZh}｜回应：${answer.slice(0, 50)}`, Date.now() - t0);
        roundToolNames.push(name);
        continue;
      }

      /* ---- B2：讲透这一张牌 ---- */
      if (name === "interpret_card" || name === "interpret_all_cards") {
        /**
         * ⚠️ 2026-11-04 快速模式：一次讲**多张**牌。
         *
         * ⚠️ 两种入口（同一套逻辑）：
         *   · interpret_card —— 深度模式专用（单张）
         *   · interpret_all_cards —— 快速模式专用（required 只有数组）
         *     给模型"没有单张选项" → 它才会一次讲完（见 tools/definitions.ts）
         *
         * ⚠️ 为什么需要多张（而不是让模型连续调用 3 次）：
         *   每一次工具调用 = 一轮 LLM 往返 = 一次完整 prompt（~5k tokens）。
         *   3 张牌分 3 次 = 3 轮；一次讲完 = 1 轮。
         *   → 快速模式省 2 轮 ≈ 省 10k tokens ≈ 省 ¥0.16/场。
         */
        const multiIdx: number[] = Array.isArray(args.card_indexes)
          ? (args.card_indexes as unknown[])
              .map((v) => Number(v))
              .filter((n) => Number.isFinite(n))
              .map((n) => Math.max(0, Math.min(n, session.drawnCards.length - 1)))
          : [];
        const multiTexts: string[] = Array.isArray(args.readings)
          ? (args.readings as unknown[]).map((v) => String(v ?? "").trim())
          : [];
        const isMulti = multiIdx.length > 0 && multiTexts.length === multiIdx.length;

        if (isMulti) {
          /**
           * ⚠️ 快速模式：一次讲完多张牌
           * ⚠️ 守卫：每张牌都必须已揭示（reveal_card 走过）——
           *   否则模型可能在没翻牌的情况下讲牌（跳步）。
           */
          const notRevealed = multiIdx.filter((i) => {
            const sl = session.cardReadings.find((r) => r.cardId === session.drawnCards[i]?.card.id);
            return !sl?.reveal;
          });
          if (notRevealed.length > 0) {
            session.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({
                error: `第 ${notRevealed.map((i) => i + 1).join("、")} 张牌尚未揭示`,
                hint: `必须先调用 reveal_card 揭示每张牌，再调用 interpret_card 讲牌。`,
              }),
            });
            roundToolNames.push("interpret_card(拦截)");
            continue;
          }
          // 逐张落库 + 流式输出（正文仍然逐张流出，前端体验一致）
          for (let k = 0; k < multiIdx.length; k++) {
            const i = multiIdx[k];
            const txt = multiTexts[k];
            if (!txt) continue;
            const sl = ensureCardSlot(session, i);
            if (sl.reading) continue; // 幂等：已讲过的不覆盖
            sl.reading = txt;
            for (const evt of chunkDelta(txt)) yield evt;
            yield { type: "delta", delta: "\n\n" };
            yield { type: "card_reading", cardReading: { cardIndex: i } };
          }
          // ⚠️ P2-⑦：不回显正文（模型已写在 arguments 里）
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              interpreted: multiIdx.map((i) => session.cardReadings.find((r) => r.cardId === session.drawnCards[i]?.card.id)?.nameZh).filter(Boolean),
            }),
          });
          yield {
            type: "tool",
            tool: {
              name,
              args,
              resultSummary: `解读 ${multiIdx.length} 张牌`,
              durationMs: Date.now() - t0,
            },
          };
          db.logToolCall(session.id, seq, "supervisor", name, args, `解读 ${multiIdx.length} 张牌`, Date.now() - t0);
          roundToolNames.push(name);
          continue;
        }

        // ⚠️ interpret_all_cards 必须走多张分支（它的 schema 只有数组参数）
        //   如果模型没传数组 → 明确报错，别静默落到单张逻辑（会得到乱七八糟的结果）
        if (name === "interpret_all_cards") {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "缺少 card_indexes 或 readings",
              hint: "请传 card_indexes=[0,1,2] 与对应的 readings 数组（顺序一致），一次讲完所有已揭示的牌。",
            }),
          });
          roundToolNames.push("interpret_all_cards(拦截)");
          continue;
        }

        const idx = Math.max(0, Math.min(Number(args.card_index) || 0, session.drawnCards.length - 1));
        const text = String(args.reading || "").trim();
        if (!text) {
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "缺少 reading" }) });
          continue;
        }
        const slot = ensureCardSlot(session, idx);
        // ⚠️ 守卫：这张牌还没"翻"过（没有念牌 + 用户的确认回答）→ 不允许直接讲透。
        // 真实占卜师必须"翻一张、问一句、听回答、再讲"。模型偶尔会一口气
        // 调多个 interpret_card 跳过这个节奏（实测：3 张牌只翻了第 1 张）。
        if (!slot.reveal || !slot.answer) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: `第 ${idx + 1} 张牌尚未翻牌确认`,
              hint: `必须先调用 reveal_card(card_index=${idx}) 念牌并等待用户回答，才能 interpret_card。`,
            }),
          });
          roundToolNames.push(name);
          continue;
        }
        // ⚠️ 幂等守卫：已有解读的牌不覆盖重讲（重复调用会推翻已流出的正文）
        if (slot.reading) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: `第 ${idx + 1} 张「${slot.nameZh}」已解读完成`,
              hint: `这张牌的解读已生成。请继续下一张（reveal_card），或全部讲完后调用 write_reading。`,
            }),
          });
          roundToolNames.push("interpret_card(拦截)");
          continue;
        }
        slot.reading = text;
        // 该牌解读作为正文流出（前端逐段显示）
        for (const evt of chunkDelta(text)) yield evt;
        yield { type: "delta", delta: "\n\n" };
        // ⚠️ card_reading **不带 text**：正文已由上面的 delta 流式给出。
        //    旧设计这里也带全文，前端用它覆盖 reading —— 于是"覆盖"与
        //    "delta 累积"两个数据源写同一个字段，只要 delta 缓冲还有残留
        //    （rAF 分帧竞争），就会把整段文字输出两次（用户实测报告）。
        //    只带 cardIndex + 完成标记，职责单一，杜绝双写。
        yield { type: "card_reading", cardReading: { cardIndex: idx } };
        session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ interpreted: slot.nameZh, text }) });
        yield { type: "tool", tool: { name, args, resultSummary: `解读 ${slot.nameZh}：${text.slice(0, 50)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `解读 ${slot.nameZh}`, Date.now() - t0);
        roundToolNames.push(name);

        // ---- 节奏交给用户（真实塔罗师讲完一张会停顿等你消化）----
        // ⚠️ 旧设计：这里发一个 continue 型 HITL 并 await（阻塞后端），
        //    用户点「翻下一张」才继续。
        // 新设计：节奏控制**移交下一张牌的翻牌闸门**（reveal_card 里的
        //    card_flip_ready + await）——那才是用户真正要做的动作（亲手点开牌）。
        //    这里**不发 ask_user**：
        //    - 发而不 await 会留下一个"悬空 ask"（前端渲染了面板，但后端没在等）
        //      → 用户点它必然 409「当前没有等待回答的问题」（实测复现）
        //    - 「翻下一张」按钮移除：点牌就是翻牌，两个入口重复
        //    - 插话能力保留在翻牌闸门里（flip 型 ask 自带输入框，同样写 interjections）
        // 少一次 LLM 往返：用户点牌时后端已经等在闸门上了。
        const isLast = idx >= session.drawnCards.length - 1;
        if (!isLast) {
          const nextPos = ["过去", "当下", "未来"][idx + 1] ?? `第${idx + 2}张`;
          yield { type: "phase", phase: "interpret", label: `「${slot.nameZh}」讲完了 · 点开「${nextPos}」那张牌继续` };
          // ⚠️ 这里**不 await**：翻牌闸门在下一轮 reveal_card 里等用户。
          //    预检索也挪到闸门放行时触发（那里才知道用户点了牌）。
          //    本轮先把"已讲完"的提示写进历史（走 pendingUserNotes：
          //    直接 push user 会隔断 deferred tool 响应 → MiniMax 400）。
          pendingUserNotes.push(`（第 ${idx + 1} 张「${slot.nameZh}」已解读完毕，等待用户翻开下一张）`);
        }
        continue;
      }

      /* ---- write_reading：子 Agent 管线 ---- */
      if (name === "write_reading") {
        // ⚠️ 守卫：逐张解读模式下，所有牌都讲完才允许进入最终综合。
        // 模型容易在讲完第 1 张后就调用 write_reading 提前收尾（实测：3 张牌只讲了 1 张）。
        // 这里拦住并明确告知还差哪几张，逼它继续 reveal_card/interpret_card。
        // ⚠️ 零牌路径：total=0 时旧条件直接放行整条管线（无牌面依据的"解读"）——必须拦。
        // ⚠️ 卡槽对齐：cardReadings 按"首次触牌顺序" append，不能按下标对 drawnCards，
        //    统一用 cardId 对齐（乱序翻牌时旧逻辑会点名错牌）。
        const total = session.drawnCards.length;
        const doneCardIds = new Set(
          session.cardReadings.filter((r) => r.reading).map((r) => r.cardId)
        );
        if (total === 0) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "还没有抽牌，不能开始最终综合",
              hint: "请先 offer_card_selection（用户亲手选）或 draw_cards（快速抽牌），再逐张 reveal_card + interpret_card。",
            }),
          });
          roundToolNames.push("write_reading(拦截)");
          continue;
        }
        if (doneCardIds.size < total) {
          const missing = session.drawnCards
            .map((d, i) => ({ d, i }))
            .filter(({ d }) => !doneCardIds.has(d.card.id))
            .map(({ d, i }) => `第${i + 1}张「${d.card.nameZh}」`);
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "还有牌没讲完",
              missing,
              hint: `请先对 ${missing.join("、")} 依次调用 reveal_card（念牌+等用户回答）与 interpret_card（讲透这一张），全部讲完后才能调用 write_reading 做最终综合。`,
            }),
          });
          yield {
            type: "phase",
            phase: "interpret",
            label: `还有 ${missing.length} 张牌没讲——继续翻牌`,
          };
          roundToolNames.push("write_reading(拦截)");
          continue;
        }
        const focus = (args.focus as string) || "综合";
        // P1-⑩：推进阶段（逐张解读 → 综合）
        session.ritualPhase = advancePhase(session.id, session.ritualPhase ?? "per_card", "synthesis");
        yield { type: "phase", phase: "interpret", label: `子 Agent 管线启动（侧重：${focus}）…` };
        yield { type: "tool", tool: { name, args, resultSummary: "启动分析师→撰写者→审校者管线", durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, "启动管线", Date.now() - t0);

        // ① 分析师
        let notes = "";
        try {
          for await (const evt of runAnalyst(config, session)) {
            if (evt.type === "subagent" && evt.subagent?.detail) {
              db.logToolCall(session.id, seq, "analyst", "analyze", { cards: session.drawnCards.length }, evt.subagent.detail, 0);
            }
            yield evt;
          }
          notes = session.analystNotes;
        } catch (e) {
          // ⚠️ P3-⑫：内部异常只进服务端日志，不发给客户端
          console.error("[supervisor] 分析师异常:", e);
          yield { type: "error", error: "分析师暂时无法工作，请稍后重试" };
          db.failSession(session.id, "llm_error");
          return;
        }
        if (!notes) {
          yield { type: "error", error: "分析师未产出笔记" };
          db.failSession(session.id, "analyst_empty");
          return;
        }

        // ② 撰写者（初稿）
        // ⚠️ 逐张解读模式：正文已由 interpret_card 逐段生成并流给用户，
        //    这里**不再重写全文**（会与已流出的内容重复），只跑分析+审校。
        const perCardMode = session.cardReadings.some((r) => r.reading);
        let reading = "";
        if (perCardMode) {
          // 用已生成的逐张解读作为待审校正文
          reading = buildFinalReading(session);
          yield {
            type: "subagent",
            subagent: { agent: "writer", action: "逐张解读已就位，跳过重写", detail: `${reading.length} 字` },
          };
        } else {
          try {
            const gen = runWriter(config, session, focus);
            let first = true;
            while (true) {
              const { done, value } = await gen.next();
              if (done) break;
              if (first && value.type === "subagent") { first = false; }
              if (value.type === "delta") reading += value.delta;
              yield value;
            }
          } catch (e) {
            // ⚠️ P3-⑫：内部异常只进服务端日志
            console.error("[supervisor] 撰写中断:", e);
            yield { type: "error", error: "解读撰写中断，请稍后重试" };
            db.failSession(session.id, "llm_error");
            return;
          }
        }

        // ③ 审校者
        let review: ReviewResult | null = null;
        let revision = "";
        try {
          yield { type: "phase", phase: "review", label: "审校者正在检视解读…" };
          for await (const evt of runReviewer(config, session, reading)) {
            if (evt.type === "review") review = evt.review ?? null;
            yield evt;
          }
          revision = (session as unknown as { __revision?: string }).__revision ?? "";
        } catch (e) {
          /* ⚠️ 审校失败不阻断，但**必须给出一个 review 事件**：
           *    审校是流程的一环（前端有审校面板、评估脚本断言 review 维度）。
           *    此前这里静默 catch 掉 → 审校不可用时前端看不到任何审校信息，
           *    评估侧也判成"review 维度未达标"（实测：reviewer 失败率 75%，
           *    因为它在流程末尾、正好吃到限流窗口的尾部）。
           *    降级策略：审校不可用 → 按"通过"处理并如实标注来源。
           *    （底线：降级不删 —— 宁可标注"审校暂不可用"，也不要静默消失。）
           *
           * ⚠️ P3-⑩（假绿灯修复）：这个降级 review **不能计入通过率**。
           *    它根本没有审校（scores 全 0），把它算作"通过"会让指标失真。
           *    所以打 `truncated: true` 标记 —— 复用同一个"不计入分母"的通道
           *    （语义上略宽：都是"未经完整审校"）。
           *    ⚠️ 为什么复用而不是新增字段：
           *    两者的处理方式完全一致（都不计入分母 + 都标注），
           *    新增字段会让分析脚本要判两个条件 —— 反而更容易漏。
           */
          const reason = e instanceof Error ? e.message : "未知错误";
          review = {
            pass: true,
            scores: { grounding: 0, empathy: 0, tone: 0 },
            comment: `审校服务暂不可用（${reason.slice(0, 60)}），本次解读未经审校`,
            truncated: true,
          };
          yield {
            type: "review",
            review: { ...review },
          };
          yield { type: "subagent", subagent: { agent: "reviewer", action: "审校不可用，已跳过（降级）" } };
        }

        // Reflexion：不过 → 重写一次 → 重新审校
        // ⚠️ 逐张模式不重写（正文已分段落给用户，重写会造成内容不一致），
        //    改为把审校意见作为提示，让后续 close_reading 收束时采纳。
        if (review && !review.pass && revision) {
          if (!perCardMode) {
            yield { type: "phase", phase: "interpret", label: "审校未通过 · 撰写者依据修改指令重写…" };
            db.updateSessionReading(session.id, reading); // 先存初稿
            try {
              reading = "";
              for await (const evt of runWriter(config, session, focus, revision)) {
                if (evt.type === "delta") reading += evt.delta;
                yield evt;
              }
              // 重写后再审校一次（判断新版是否达标，而非沿用旧结论）
              yield { type: "phase", phase: "review", label: "审校者复检重写稿…" };
              let reReview: ReviewResult | null = null;
              try {
                for await (const evt of runReviewer(config, session, reading)) {
                  if (evt.type === "review") reReview = evt.review ?? null;
                  yield evt;
                }
              } catch (e) {
                // ⚠️ P3-⑦：复检失败沿用原 review（不阻断），
                //    但必须留痕 —— 否则"没复检"和"复检通过"无法区分。
                dbLog("审校复检失败，沿用原结论", e);
              }
              if (reReview) review = reReview;
              } catch (e) {
                // ⚠️ P3-⑫：内部异常只进服务端日志
                console.error("[supervisor] 重写中断:", e);
                yield { type: "error", error: "重写中断，请稍后重试" };
              // 方向④：重写失败不终止会话（沿用原稿），但落库归因便于统计
              try { db.logTiming(session.id, "rewrite_fail", 0, e instanceof Error ? e.message.slice(0, 80) : "未知"); } catch (e2) { dbLog("记录重写失败归因失败", e2); }
            }
          } else {
            // 逐张模式：把审校意见挂到 session，供收束阶段采纳
            (session as unknown as { __revision?: string }).__revision = revision;
            yield {
              type: "phase",
              phase: "review",
              label: "审校提出修改意见，将在收束时采纳",
            };
          }
        }

        db.updateSessionReading(session.id, reading);
        // ⚠️ 同步写回内存会话（端到端实测发现的真 bug）
        //   原来只落库、没写 session.reading —— 而 /api/session/[id] 的
        //   **live 分支返回的是 live.reading**（内存值），DB 值只在
        //   "会话不在内存里"时才读 → 前端刷新后**解读正文变空**。
        //   （用户可见故障：占卜做完了，刷新一下内容就没了。）
        session.reading = reading;
        // 存审校结果（供 close_reading 收束时落库）
        (session as unknown as { __lastReview?: ReviewResult | null }).__lastReview = review;
        // ⚠️ P2-⑨：标记"综合已完成"（close_reading 守卫的前置条件）
        //    时序要点：综合完成于**这里**，而 close_reading 发生在会话结束**之前**
        //    → 不能用 finished 判断（那会让守卫永远拦截收束）。
        session.synthesisDone = true;
        // ⚠️ 不在这里结束会话：逐张模式下还需要 close_reading 做收束
        // （收束语 + 一条行动建议 + 收尾追问）。
        // 旧流程（没有逐张解读）也走 close_reading，保证流程一致。
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            review: review ? { pass: review.pass, scores: review.scores } : null,
            revision: perCardMode ? "" : revision,
            note: "最终综合已完成。请接着调用 close_reading 做收束（收束语 + 一条行动建议 + 收尾追问）。",
          }),
        });
        roundToolNames.push(name);
        continue;
      }

      /* ---- 承约阶段（A1：问题重述确认）---- */
      if (name === "establish_contract") {
        // ⚠️ 幂等守卫：承约只做一次（重复承约会打断流程节奏）
        if (session.contractQuestion) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "承约已完成，不要重复",
              hint: `已确认的问题是「${session.contractQuestion}」。请继续下一步：invoke_three_questions 或 offer_card_selection。`,
            }),
          });
          roundToolNames.push("establish_contract(拦截)");
          continue;
        }
        const contractQ = String(args.question || session.question).trim();
        const scope = String(args.scope || "我看过去、现在，以及你正在犹豫的那条路").trim();
        session.contractQuestion = contractQ;
        session.scopeNote = scope;
        // 确认选项（模型可能漏传 → 通用兜底）
        let confirmOptions = Array.isArray(args.confirm_options)
          ? (args.confirm_options as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (confirmOptions.length < 2) confirmOptions = ["对，就是这个", "其实我想问点别的", "再具体一点"];
        askPrompt = contractQ;
        options = confirmOptions;        yield { type: "contract", contract: { question: contractQ, scope } };
        yield {
          type: "phase",
          phase: "wait_user",
          label: "占卜师复述问题，请你确认…",
        };
        // ⚠️ 闸门先就绪再通知（避免客户端抢跑 409）
        const contractWait = waitUserAnswer(session, contractQ, confirmOptions, "contract", hitlClock, (level, kind) => pendingNudges.push(makeNudge(level, kind)));
        yield {
          type: "ask_user",
          ask: {
            question: contractQ,
            options: confirmOptions,
            allowFree: true,
            prompt: contractQ,
            kind: "contract",
          },
        };
        const answer = await contractWait;
        // 超时/断开：以"用户未确认"记录，沿用原始问题继续（不阻塞流程）
        const confirmed = isHitlGone(answer) ? "（用户未回应，按原问题继续）" : answer;
        if (!isHitlGone(answer)) {
          for (const tag of extractEmotionTags(answer)) {
            if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
          }
          // 用户说"不是这个" → 用用户自己的话作为具体问题
          if (/^(不是|不对|其实|我想问|换)/.test(answer.trim()) && answer.length > 6) {
            session.contractQuestion = answer.trim();
          }
        }
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          /**
           * P2-⑦：不回显 contract（模型已写在 arguments 里）→ 实测重复率从 54% 降到 0。
           * ⚠️ 保留 userConfirmed —— **用户的确认是新信息**（模型无从得知）。
           * ⚠️ 保留 scope —— 它是**牌阵范围**（模型传的），但很短且是流程关键状态，
           *    留着能让模型确认"我承诺的是这个范围"；如需极致压缩可再删。
           */
          content: JSON.stringify({ scope, userConfirmed: confirmed }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `承约确认：${session.contractQuestion}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `承约：${session.contractQuestion}`, Date.now() - t0);
        /**
         * P1-⑩：推进阶段（承约 → 呼召）
         * ⚠️ 2026-11-04 快速模式：承约完**直接进选牌**（跳过呼召三问）。
         *   这是快速模式省下 3 次 HITL 交互的关键一跳。
         */
        const contractMode = session.mode ?? "deep";
        session.ritualPhase = advancePhase(
          session.id,
          session.ritualPhase ?? "contract",
          contractMode === "quick" ? "card_selection" : "invocation"
        );
        if (contractMode === "quick") {
          yield { type: "phase", phase: "wait_user", label: "快速一问 · 直接为你抽牌" };
        }
        roundToolNames.push(name);
        continue;
      }

      /* ---- 呼召阶段（A3：三问呼召）---- */
      if (name === "invoke_three_questions") {
        // ⚠️ 幂等守卫：呼召只做一次（重复呼召会覆盖已有回答）
        if (session.invocation?.answers?.length) {
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              error: "三问呼召已完成，不要重复",
              hint: `用户已回答 ${session.invocation.answers.length} 个问题。请继续 offer_card_selection 选牌。`,
            }),
          });
          roundToolNames.push("invoke_three_questions(拦截)");
          continue;
        }
        let questions = Array.isArray(args.questions)
          ? (args.questions as unknown[]).map(String).filter((s) => s.trim())
          : [];
        if (questions.length < 3) {
          // 兜底：模型漏传或传少了 → 用通用三问
          questions = [
            `关于「${session.contractQuestion ?? session.question}」，你最想知道的答案是什么？`,
            "在这件事上，你已经打算做什么了？",
            "有什么是你担心发生、但还没真正面对的？",
          ];
        }
        questions = questions.slice(0, 3);
        session.invocation = { questions, answers: [] };
        yield { type: "invocation", invocation: { questions } };
        yield { type: "phase", phase: "wait_user", label: "呼召——请你回答三个问题…" };
        // ⚠️ 闸门先就绪再通知（避免客户端抢跑 409）
        const invocationWait = waitUserAnswer(session, questions.join("\n"), undefined, "invocation", hitlClock, (level, kind) => pendingNudges.push(makeNudge(level, kind)));
        yield {
          type: "ask_user",
          ask: {
            question: questions.join("\n"),
            options: undefined,
            allowFree: true,
            prompt: questions.join("\n"),
            kind: "invocation",
          },
        };
        const answer = await invocationWait;
        if (isHitlGone(answer)) {
          // 超时/断开：呼召未完成——记录空回答继续（骨架缺失但不挂死）
          session.invocation = { questions, answers: [] };
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            // ⚠️ P2-⑦：同上方 —— 不回显 questions（模型已写在 arguments 里）
            content: JSON.stringify({
              answers: [],
              note: "用户未回应呼召",
            }),
          });
          yield { type: "tool", tool: { name, args, resultSummary: "三问呼召：用户未回应", durationMs: Date.now() - t0 } };
          db.logToolCall(session.id, seq, "supervisor", name, args, "呼召：未回应", Date.now() - t0);
          roundToolNames.push(name);
          continue;
        }
        // 解析 "1. xxx\n2. xxx\n3. xxx" 形式的回答
        const answers = answer
          .split("\n")
          .map((l) => l.replace(/^\s*\d+[.、)]\s*/, "").trim())
          .filter((l) => l.length > 0);
        session.invocation = { questions, answers: answers.length ? answers : [answer] };
        for (const tag of extractEmotionTags(answer)) {
          if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
        }
        session.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          /**
           * P2-⑦：questions 是**模型自己写的**（在 arguments 里）→ 不回显。
           * ⚠️ 只回传**新增信息**：用户对每个问题的回答。
           * ⚠️ 保持 q/a 的**配对结构** —— 模型需要知道"哪个答案对应哪个问题"，
           *    否则无法把回答串进后续解读。这里用**序号**代替完整问题文本，
           *    既保留了配对语义，又省掉了整段问题的字数。
           */
          content: JSON.stringify({
            answers: session.invocation.answers.map((a, i) => ({ i, a })),
          }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `三问呼召：${session.invocation.answers.length} 个回答`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `呼召：${session.invocation.answers.join(" / ").slice(0, 80)}`, Date.now() - t0);
        // P1-⑩：推进阶段（呼召 → 选牌）
        session.ritualPhase = advancePhase(session.id, session.ritualPhase ?? "invocation", "card_selection");
        roundToolNames.push(name);
        continue;
      }

      /* ---- HITL 工具（ask_user / offer_card_selection / fate_crossroads）---- */
      if (name === "ask_user" || name === "offer_card_selection" || name === "fate_crossroads") {
        let askEvent: AgentEvent;
        // askPrompt / options 已在工具循环顶部声明（承约与呼召分支共用）

        if (name === "ask_user") {
          const q = String(args.question || "请补充你的困惑");
          options = Array.isArray(args.options) ? (args.options as string[]).map(String) : undefined;
          askPrompt = q;
          askEvent = { type: "ask_user", ask: { question: q, options, allowFree: true, prompt: q } };
        } else if (name === "offer_card_selection") {
          /* ⚠️ P2-⑩/P2-⑨：仪式守卫已**上移到统一入口**
           *    （见上方 TOOL_PHASE_REQUIREMENT 查表 + canEnter）。
           *    原来这里和 draw_cards 各抄了一份手写守卫 ——
           *    加新工具时必然漏（这正是 bug 的成因）。
           *    判定规则仍由 ritual-machine 统一实现，行为不变。
           */
          const count = Math.min(Math.max(Number(args.count) || 3, 1), 5);
          askPrompt = `请凭直觉，从 ${count} 张牌中选出属于你的 ${count} 张命运之牌`;
          // 随机抽 7 张候选牌组成扇面（比全 78 张更聚焦，保留"直觉挑选"仪式感）
          const pool = [...TAROT_CARDS];
          const fanCards = Array.from({ length: Math.min(7, pool.length) }, () => {
            const idx = Math.floor(Math.random() * pool.length);
            const card = pool.splice(idx, 1)[0];
            return { id: card.id, nameZh: card.nameZh, image: card.image };
          });
          askEvent = {
            type: "ask_user",
            ask: { question: askPrompt, allowFree: false, prompt: askPrompt },
            fanCards,
            fanCount: count,
            // 选牌模式：额外标记，前端渲染扇面
          } as AgentEvent & { cardSelection?: boolean };
          (askEvent as AgentEvent & { cardSelection?: boolean }).cardSelection = true;
        } else {
          // fate_crossroads
          const prompt = String(args.prompt || "命运走到了岔路口");
          let branches = Array.isArray(args.branches)
            ? (args.branches as unknown[]).map(String).filter((b) => b.trim().length > 0)
            : [];
          // ⚠️ 兜底：模型偶尔只写 prompt 叙述而漏传 branches
          // （实测 DB 里出现过 branches(NOT ARRAY)）→ 前端 options 为空 + crossroads=true
          //    会导致"既没选项也没输入框"的彻底死锁。
          // 这里从 prompt 里抠出选项；抠不出就给通用选项，保证一定能继续。
          if (branches.length === 0) {
            branches = extractBranchesFromPrompt(prompt);
          }
          if (branches.length === 0) {
            branches = ["跟着直觉走", "稳妥为先", "先不决定，再想想"];
          }
          askPrompt = prompt;
          options = branches;
          askEvent = {
            type: "ask_user",
            ask: { question: prompt, options: branches, allowFree: true, prompt },
          };
          (askEvent as AgentEvent & { crossroads?: boolean }).crossroads = true;
        }

        yield { type: "phase", phase: "wait_user", label: "占卜师需要你的回应…" };
        // ⚠️ 闸门必须**先就绪、再通知前端**（与翻牌闸门同一原则）：
        //    waitUserAnswer 在 await 表达式求值时才设置 session.pendingAsk。
        //    若先 yield askEvent 再 await，前端/客户端收到事件后立刻应答，
        //    但后端还没进入等待 → pendingAsk 为空 → /api/answer 返回 409
        //    「当前没有等待回答的问题」→ 应答被丢弃 → 后端等满 5min
        //    HITL 超时 → 8min 看门狗中止 → client_disconnect。
        //    实测症状：每场占卜都撞满 8 分钟超时（eval 全军覆没）。
        const askWait = waitUserAnswer(session, askPrompt, options, undefined, hitlClock, (level, kind) => pendingNudges.push(makeNudge(level, kind)));
        yield askEvent;

        const userAnswer = await askWait;

        // 超时/断开：HITL 通道统一收尾——选牌超时改为随机代抽（保流程），
        // 提问类以"（用户未回应）"记录，流程继续不挂死。
        if (isHitlGone(userAnswer)) {
          if (name === "offer_card_selection") {
            const count = Math.min(Math.max(Number(args.count) || 3, 1), 5);
            const pool = [...TAROT_CARDS];
            const drawn: DrawnCard[] = [];
            for (let i = 0; i < count; i++) {
              const idx = Math.floor(Math.random() * pool.length);
              const card = pool.splice(idx, 1)[0];
              drawn.push({ card, reversed: Math.random() < 0.35 });
            }
            session.drawnCards = drawn;
            session.dwellTimes = drawn.map(() => -1);
            // P1-⑩：推进阶段（选牌 → 逐张解读）
            session.ritualPhase = advancePhase(session.id, session.ritualPhase ?? "card_selection", "per_card");
            const posNames = ["过去", "当下", "未来"];
            const cards = drawn.map((d, i) => ({
              id: d.card.id, nameZh: d.card.nameZh, image: d.card.image,
              reversed: d.reversed, pos: drawn.length === 1 ? "核心指引" : posNames[i],
            }));
            db.updateSessionCards(session.id, cards);
            // ⚠️ 防剧透：同上文 —— 只发位置，不发牌名/图片
            yield {
              type: "cards",
              cards: cards.map((c, i) => ({
                id: `slot-${i}`,
                nameZh: "",
                image: "",
                reversed: false,
                pos: c.pos,
              })),
            };
            session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ answer: "random", note: "用户未回应，已随机代抽" }) });
            yield { type: "tool", tool: { name, args, resultSummary: `超时随机代抽：${cards.map((c) => c.pos).join("、")}（牌面待用户逐一翻开）`, durationMs: Date.now() - t0 } };
            db.logToolCall(session.id, seq, "supervisor", name, args, "选牌超时→随机代抽", Date.now() - t0);
            roundToolNames.push(name);
            continue;
          }
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ answer: "（用户未回应）" }) });
          yield { type: "tool", tool: { name, args, resultSummary: "用户未回应（超时/断开）", durationMs: Date.now() - t0 } };
          db.logToolCall(session.id, seq, "supervisor", name, args, "未回应", Date.now() - t0);
          roundToolNames.push(name);
          continue;
        }

        let resultSummary = `用户回应：${userAnswer.slice(0, 60)}`;

        // offer_card_selection：解析选牌（格式 "牌id,牌id,牌id|犹豫ms,犹豫ms"；"random" 表示用户请求随机代抽）
        if (name === "offer_card_selection") {
          const drawn: DrawnCard[] = [];
          let dwell: number[] = [];
          if (userAnswer.trim() === "random") {
            // 兜底：前端未收到扇面数据时，用户可请求随机代抽
            const count = Math.min(Math.max(Number(args.count) || 3, 1), 5);
            const pool = [...TAROT_CARDS];
            for (let i = 0; i < count; i++) {
              const idx = Math.floor(Math.random() * pool.length);
              const card = pool.splice(idx, 1)[0];
              drawn.push({ card, reversed: Math.random() < 0.35 });
            }
          } else {
            const [idsStr, dwellStr] = userAnswer.split("|");
            const ids = idsStr.split(",").map((s) => s.trim()).filter(Boolean);
            dwell = (dwellStr ?? "").split(",").map((s) => parseInt(s, 10) || 0);
            ids.forEach((id) => {
              const card = getCardById(id);
              if (card) drawn.push({ card, reversed: Math.random() < 0.35 });
            });
          }
          session.drawnCards = drawn;
          // P1-⑩：推进阶段（选牌 → 逐张解读）
          session.ritualPhase = advancePhase(session.id, session.ritualPhase ?? "card_selection", "per_card");
          // P1.3：犹豫时长结构化存入 session（供 writer prompt 引用："你在恋人牌前停留最久"）
          session.dwellTimes = userAnswer.trim() === "random"
            ? drawn.map(() => -1) // 随机代抽无犹豫数据
            : dwell;
          const posNames = ["过去", "当下", "未来"];
          const cards = drawn.map((d, i) => ({
            id: d.card.id, nameZh: d.card.nameZh, image: d.card.image,
            reversed: d.reversed, pos: drawn.length === 1 ? "核心指引" : posNames[i],
          }));
          db.updateSessionCards(session.id, cards);
          // ⚠️ 防剧透：resultSummary 会进 tool 事件（下发给浏览器），
          //    所以**这里也不能出现牌名** —— 只报位置与犹豫时长。
          //    真实牌名仍留在 session/draw_cards 结果里，供模型与落库使用。
          resultSummary = userAnswer.trim() === "random"
            ? `随机代抽：${cards.map((c) => c.pos).join("、")}（牌面待用户逐一翻开）`
            : `用户亲手选出：${cards.map((c) => c.pos).join("、")}；犹豫时长 ${dwell.join("/")}ms（牌面待用户逐一翻开）`;
          // ⚠️ 防剧透：cards 事件**只发位置**，不发牌名/图片/牌 id。
          //    牌面信息必须等用户亲手翻开（card_reveal）才下发 ——
          //    否则"牌背 + ？"只是障眼法，用户在 devtools 里就能看到答案。
          //    （前端只靠 index + pos 渲染牌阵，牌名在 card_reveal 时补上）
          yield {
            type: "cards",
            cards: cards.map((c, i) => ({
              id: `slot-${i}`,
              nameZh: "",
              image: "",
              reversed: false,
              pos: c.pos,
            })),
          };
        } else if (name === "fate_crossroads") {
          resultSummary = `用户选择走向：${userAnswer.slice(0, 60)}`;
        }

        session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ answer: userAnswer }) });
        // P2.1：情绪档案——从用户应答中提取情绪关键词，解读与追问持续引用
        // （占卜师"记得你说过很紧张"，而不是每次都当陌生人）
        for (const tag of extractEmotionTags(userAnswer)) {
          if (!session.emotionTags.includes(tag)) session.emotionTags.push(tag);
        }
        yield { type: "tool", tool: { name, args, resultSummary, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, resultSummary, Date.now() - t0);
        yield { type: "phase", phase: "analyze", label: "已收到你的回应，占卜继续…" };
        roundToolNames.push(name);
        // 轮次时间轴（HITL 路径也要发）
        yield {
          type: "round",
          round: {
            round,
            elapsedMs: Date.now() - roundStart,
            promptTokens: roundPromptTokens,
            toolNames: roundToolNames,
            phase: name,
          },
        };
        continue;
      }

      /* ---- 普通工具（rag_search / draw_cards）---- */
      let resultSummary = "";
      let evExtra: Partial<AgentEvent> = {};
      let toolContent: string | undefined;

      if (name === "draw_cards") {
        /* ⚠️ P1-⑩/P2-⑨：仪式守卫已**上移到统一入口**
         *    （见上方 TOOL_PHASE_REQUIREMENT 查表 + canEnter）。
         *    判定规则与原来完全一致（同样要求承约 + 呼召完成），
         *    只是把"每个分支各抄一份"改成"查表"——
         *    加新工具时不会漏防。
         */
        const spread = (args.spread as string) || "three";
        const { summary, cards } = execDrawCards(spread, session);
        resultSummary = summary;
        evExtra = { cards };
        yield { type: "phase", phase: "draw", label: `命运之牌已抽出（${spread === "single" ? "单张聚焦" : "三张时间流"}）` };
      } else if (name === "rag_search") {
        const q = String(args.query || "");
        const topK = Number(args.top_k) || 5;
        // 方向②：查询改写——口语化查询（"复合 前任"）不含牌名，
        // BM25 字面匹配近零召回（golden set 实测 Recall@5 仅 44.6%）。
        // 主题词典补牌名候选（本地零延迟；已含牌名不改写）
        const rewritten = rewriteQueryLocal(q, TAROT_CARDS.map((c) => c.nameZh));
        const { summary, currentHits, allHits } = await execRagSearch(rewritten, topK, session, q);
        resultSummary = summary;
        // 前端知识面板拿到**累计命中**（与解读 [n] 编号一致）
        // ⚠️ 只发前 12 条（编号稳定不前移；内存 session.ragHits 保留全部）
        evExtra = { ragHits: allHits.slice(0, 12) };
        yield { type: "phase", phase: "retrieve", label: `翻阅典籍：「${q.slice(0, 16)}」` };
        // 独立 rag_hits 事件：前端 KnowledgePanel 与外部集成方都依赖此事件
        // （tool 事件内嵌的 ragHits 仅作为冗余）
        if (allHits.length > 0) yield { type: "rag_hits", ragHits: allHits.slice(0, 12) };
        // 回填给 LLM 的观察结果用**压缩版**（全局编号，与知识面板 [n] 一致）
        toolContent = compressRagResult(allHits, new Set(currentHits.map((h) => h.chunkId)));
      } else {
        resultSummary = `未知工具：${name}`;
      }

      session.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolContent ?? JSON.stringify({ result: resultSummary }),
      });
      yield { type: "tool", tool: { name, args, resultSummary, durationMs: Date.now() - t0 }, ...evExtra };
      db.logToolCall(session.id, seq, "supervisor", name, args, resultSummary, Date.now() - t0);
      // 方向③：普通工具耗时落库（HITL 类工具的等待已在 waitUserAnswer 统一记录）
      db.logTiming(session.id, `tool_${name}`, Date.now() - t0);
      roundToolNames.push(name);
    }

    // ---- 轮次结束：发时间轴事件（前端可视化"Agent 在哪一步慢"）----
    yield {
      type: "round",
      round: {
        round,
        elapsedMs: Date.now() - roundStart,
        promptTokens: roundPromptTokens,
        toolNames: roundToolNames,
        phase: roundToolNames.length ? roundToolNames[roundToolNames.length - 1] : "decide",
      },
    };
    // P1-④：标脏（每轮结束标一次即可 —— 快照由 10s 定时器统一落库）
    markSessionDirty(session.id);
  }

  yield { type: "error", error: "占卜师陷入沉思无法自拔…（达到最大轮次）" };
  db.failSession(session.id, "max_rounds");
  } finally {
    // 退出路径统一补齐 tool_call 响应（保持协议配对）
    flushPendingToolResponses();
    // ⚠️ P2-⑩：这里**不再**释放 busy —— 所有权归路由层（releaseSession）。
    //   重复释放虽然幂等，但会让"占用/释放"的对称性只存在于一半路径里，
    //   以后加新调用点时极易漏掉其中一边。
  }
  } finally {
    // runAgent 外层：无论从哪条路径退出（含 localFallback）都收尾
    // ⚠️ P2-⑩：busy 的释放同样交给路由层（见 api/interpret/route.ts 的 finally）。
    // P2-②（第二轮优化分析 2026-11 ②）：清除截断标记 —— **原本零调用点**。
    // ⚠️ 后果：`truncatedSessions` 这个 Set 只 add 不 delete →
    //    每场占卜加一条、从不移除 → 进程级内存**单调增长**（纯泄漏）。
    //    占卜是高频操作，几周后就是几十 MB 的常驻内存。
    // ⚠️ 放在最外层 finally：无论正常结束 / 异常 / 降级路径都要清。
    try { clearTruncated(session.id); } catch { /* 清理失败不阻断 */ }
    // P1-④：退出前把最终状态落快照（进程重启后可恢复）
    try {
      db.saveSessionState(session.id, snapshotSession(session));
    } catch { /* 快照失败不阻断 */ }
    // 方向①：会话收尾落画像（主题 + 情绪轨迹，90 天衰减在 db 层处理）
    if (session.userKey) {
      persistMemory(session.userKey, session.question, session.emotionTags);
    }
  }
}

