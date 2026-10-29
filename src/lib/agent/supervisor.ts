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
import { waitUserAnswer, isHitlGone } from "./hitl";
import { markSessionDirty, snapshotSession } from "./session";
import { TOOLS } from "./tools/definitions";
import { execRagSearch, prefetchForCard, RAG_BUDGET } from "./tools/rag";
import { execDrawCards } from "./tools/cards";
import { runAnalyst, runWriter, runReviewer, type ReviewResult } from "./subagents";
import { runLocalFallback } from "./fallback";
import {
  extractEmotionTags, suggestPersonaByEmotion, extractBranchesFromPrompt,
  buildFinalReading, ensureCardSlot, compressRagResult, trimHistory,
  buildSystemPrompt, buildPlanSteps,
} from "./helpers";
import type { AgentEvent, AgentSession, DrawnCard } from "./types";

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
  // ⚠️ 并发互斥：同一会话同时只允许一个生成器推进。
  // 挂在 pendingAsk 时（历史末尾是未配对的 tool_calls），并发 interpret 会把
  // user 消息插到 tool 响应之前 → 下一次 callLLM 直接 400 协议错位。
  // 路由层负责在入口检查 busy（409），这里兜底设置并在 finally 释放。
  session.busy = true;
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
    session.messages.push({ role: "user", content: `我想占卜：${question}` });
    // 记录 prompt 版本，便于后续版本效果对比
    try { db.updateSessionPromptVersion(session.id, PROMPT_VERSION); } catch { /* ignore */ }
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

  yield { type: "phase", phase: "analyze", label: `${session.persona.emoji} ${session.persona.name}开始凝听你的问题…` };

  /* ---- 方向⑤：Plan-Execute 模式（AGENT_MODE=plan）----
   * 与默认 ReAct 的差异：进入工具循环前先让 supervisor 产出一份显式计划
   * （步骤清单），作为系统提示注入后续所有轮次。收益：
   * 1. 长流程（10+ 轮）不迷路——计划是"地图"，每轮决策对照计划推进
   * 2. 用户可见"占卜仪轨路线图"（前端 plan 事件渲染），HITL 等待有预期
   * 3. 落库 agent_mode 便于 A/B 对比轮次/token 差异（面试数据点）
   * 计划生成失败（LLM 异常）静默降级回 ReAct——降级不删是底线。 */
  const agentMode = process.env.AGENT_MODE === "plan" ? "plan" : "react";
  session.agentMode = agentMode;
  try { db.updateSessionPromptVersion(session.id, `${PROMPT_VERSION}/${agentMode}`); } catch { /* ignore */ }
  const planSteps = agentMode === "plan" ? await buildPlanSteps(config, session) : null;
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

  // 轮次上限：逐张解读模式下轮次翻倍
  // 承约1 + 呼召1 + 选牌1 + 检索2 + (翻牌+解读)×3 + 综合1 + 收束1 ≈ 14 轮
  const MAX_ROUNDS = Number(process.env.MAX_ROUNDS) || 22;
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
      const LATE_ROUND = Math.max(10, MAX_ROUNDS - 6); // 留 6 轮缓冲
      const perCardPending = session.cardReadings.filter((r) => r.reading).length < session.drawnCards.length;
      const needWrapUp = (round >= LATE_ROUND || session.ragCallCount > RAG_BUDGET) && !perCardPending;
      // ---- 检索工具动态下架（防"预算拒绝后无限重试"死循环）----
      // 实测：预算耗尽后模型仍连撞 16 次 rag_search 直到 deadline。
      // 工具响应里的"不要再检索"劝不住它——必须在下一轮直接不给这个工具。
      // ⚠️ 与 execRagSearch 的拦截条件保持一致（>= 而非 >）：
      //    第 3 次检索成功后 ragCallCount=3，第 4 次起被拦截（count 不再增长），
      //    所以下架判定必须用 >=，否则永远差一次不触发。
      const ragBanned = session.ragCallCount >= RAG_BUDGET;
      const availableTools = ragBanned ? TOOLS.filter((t) => t.function.name !== "rag_search") : TOOLS;
      if (needWrapUp && session.drawnCards.length > 0) {
        trimmed = [
          ...trimmed,
          {
            role: "system" as const,
            content: `⚠️ 流程即将到达轮次上限（当前第 ${round} 轮，检索已 ${session.ragCallCount} 次）。你手里已有 ${session.drawnCards.length} 张牌与检索结果，信息完全足够。本轮必须调用 write_reading 启动解读管线，不得再调用任何检索或提问工具。`,
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
      decision = await callLLM(config, trimmed, availableTools, session.id, "supervisor");
      roundPromptTokens = decision.usage?.prompt;
      // failover 生效时更新会话粘住的 provider（保持后续风格一致）——按名称比较，避免对象实例误判
      const used = buildProviders().find((p) => p.name === decision.provider);
      if (used && used.name !== config?.name) {
        config = used;
        (session as unknown as { __provider?: LLMProvider }).__provider = used;
        yield { type: "phase", phase: "analyze", label: `主模型连接不畅，已切换备用模型（${used.name}）` };
      }
    } catch (e) {
      yield { type: "error", error: `占卜师暂时失联：${e instanceof Error ? e.message : "未知错误"}` };
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
        yield {
          type: "ask_user",
          ask: { question, options: cOptions, allowFree: true, prompt: question, kind: "closing" },
        };
        const answer = await waitUserAnswer(session, question, cOptions, "closing", hitlClock);
        // 超时/断开：以"未回应"收尾落库（不再无限挂起，也不拿哨兵值当用户回答）
        if (isHitlGone(answer)) {
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ closing, question, userAnswer: "（用户未回应，已收束）" }) });
          const finalReading = buildFinalReading(session);
          db.updateSessionReading(session.id, finalReading);
          const lastReview = (session as unknown as { __lastReview?: ReviewResult | null }).__lastReview ?? null;
          db.finishSession(session.id, lastReview);
          session.finished = true;
          yield { type: "done" };
          return;
        }
        session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ closing, question, userAnswer: answer }) });
        yield { type: "tool", tool: { name, args, resultSummary: `收束完成，用户回应：${answer.slice(0, 40)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `收束｜${answer.slice(0, 50)}`, Date.now() - t0);
        roundToolNames.push(name);
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
        yield { type: "done" };
        return;
      }

      /* ---- B1：逐张翻牌（翻牌闸门 → 念牌 → 确认问题）---- */
      if (name === "reveal_card") {
        const idx = Math.max(0, Math.min(Number(args.card_index) || 0, session.drawnCards.length - 1));
        const drawn = session.drawnCards[idx];
        if (!drawn) {
          session.messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ error: "还没有抽牌" }) });
          continue;
        }
        // ⚠️ 幂等守卫：同一张牌不重复念牌/重问（模型偶发重复调用，
        // 会覆盖用户已给的确认回答）
        const existingSlot = session.cardReadings.find((r) => r.cardId === drawn.card.id);
        if (existingSlot?.reveal && existingSlot.answer) {
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
        // ⚠️ 翻牌闸门必须**先就绪、再通知前端**：
        //    waitUserAnswer 是在 await 表达式求值时才设置 session.pendingAsk，
        //    若先发 flip_ready 再 await，前端收到"可点"信号时后端还没在等
        //    → 用户抢跑点击 → /api/answer 409「当前没有等待回答的问题」。
        //    症状：对话流里的牌点很多次没反应（409 被吞），
        //    而顶部时间线的牌因为用户"看了一会儿才点"反而能翻。
        //
        //    做法：先启动等待（拿到 pendingAsk），**再**发 flip_ready ——
        //    前端的"可点"状态与后端闸门严格对齐，杜绝抢跑。
        const flipWait = waitUserAnswer(session, flipPrompt, undefined, "flip", hitlClock);
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
        yield {
          type: "ask_user",
          ask: { question, options: qOptions, allowFree: true, prompt: question, kind: "card_confirm" },
        };
        const answer = await waitUserAnswer(session, question, qOptions, "card_confirm", hitlClock);
        // 超时/断开：以"用户未回应"记录，流程不中断（占卜师按默认情况讲牌）
        if (isHitlGone(answer)) {
          slot.answer = "（用户未回应）";
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              card: `${pos}·${drawn.card.nameZh}`,
              narrative, meaning, question,
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
          content: JSON.stringify({
            card: `${pos}·${drawn.card.nameZh}`,
            narrative, meaning, question,
            userAnswer: answer,
          }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `翻牌 ${pos}·${drawn.card.nameZh}，用户回应：${answer.slice(0, 40)}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `翻牌 ${drawn.card.nameZh}｜回应：${answer.slice(0, 50)}`, Date.now() - t0);
        roundToolNames.push(name);
        continue;
      }

      /* ---- B2：讲透这一张牌 ---- */
      if (name === "interpret_card") {
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
          yield { type: "error", error: `分析师异常：${e instanceof Error ? e.message : "未知"}` };
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
            yield { type: "error", error: `撰写中断：${e instanceof Error ? e.message : "未知"}` };
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
        } catch {
          // 审校失败不阻断
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
              } catch { /* 复检失败沿用原 review */ }
              if (reReview) review = reReview;
            } catch (e) {
              yield { type: "error", error: `重写中断：${e instanceof Error ? e.message : "未知"}` };
              // 方向④：重写失败不终止会话（沿用原稿），但落库归因便于统计
              try { db.logTiming(session.id, "rewrite_fail", 0, e instanceof Error ? e.message.slice(0, 80) : "未知"); } catch { /* ignore */ }
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
        // 存审校结果（供 close_reading 收束时落库）
        (session as unknown as { __lastReview?: ReviewResult | null }).__lastReview = review;
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
        const answer = await waitUserAnswer(session, contractQ, confirmOptions, "contract", hitlClock);
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
          content: JSON.stringify({ contract: session.contractQuestion, scope, userConfirmed: confirmed }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `承约确认：${session.contractQuestion}`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `承约：${session.contractQuestion}`, Date.now() - t0);
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
        const answer = await waitUserAnswer(session, questions.join("\n"), undefined, "invocation", hitlClock);
        if (isHitlGone(answer)) {
          // 超时/断开：呼召未完成——记录空回答继续（骨架缺失但不挂死）
          session.invocation = { questions, answers: [] };
          session.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              invocation: questions.map((q) => ({ q, a: "" })),
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
          content: JSON.stringify({
            invocation: questions.map((q, i) => ({ q, a: session.invocation?.answers[i] ?? "" })),
          }),
        });
        yield { type: "tool", tool: { name, args, resultSummary: `三问呼召：${session.invocation.answers.length} 个回答`, durationMs: Date.now() - t0 } };
        db.logToolCall(session.id, seq, "supervisor", name, args, `呼召：${session.invocation.answers.join(" / ").slice(0, 80)}`, Date.now() - t0);
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
        yield askEvent;

        const userAnswer = await waitUserAnswer(session, askPrompt, options, undefined, hitlClock);

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
    session.busy = false; // 释放并发锁（允许后续追问）
  }
  } finally {
    // runAgent 外层：无论从哪条路径退出（含 localFallback）都释放锁
    session.busy = false;
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

