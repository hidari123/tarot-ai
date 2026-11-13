import { useCallback, useEffect, useRef } from "react";

import { parseAgentEvent } from "@/lib/agent/schema";
import { playSfx } from "@/lib/audio/ambient";

import { STAGE_GONG_PHASES } from "./types";
import type { AgentCard, FlowEntry, SpreadCard } from "./types";
import type { DivinationStateApi } from "./useDivinationState";
import { splitSseFrames } from "./useSseParser";

/**
 * useStreamRunner —— SSE 流：消费 / 分发 / 取消 / 断点续传
 * （2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么把 consumeStream 和事件分发放在**同一个 hook**里：
 *   · React 19 的 `useEffectEvent` 返回的函数**不能跨组件/跨 hook 传递**
 *     （eslint `react-hooks/rules-of-hooks` 明确禁止）
 *   · 若拆成两个 hook（runner 收 handler、dispatcher 产出 handler）
 *     → dispatcher 的返回值要传给 runner → **违规** ❌
 *   → 合并后：dispatch 在**同一个 hook 内**被 onEvent 调用 → 合法 ✅
 *   · 另一个替代方案是"渲染期写 ref.current"（老写法）
 *     → eslint `react-hooks/refs` 规则**禁止**渲染期写 ref（React 19 新规则）❌
 *   → useEffectEvent 是 React 官方的正解：永远读到最新值、引用永不变 ✅
 *
 * ⚠️ 本 hook 的三层职责：
 *   ① useSseParser      —— 纯函数（字节 → 帧），可单测
 *   ② consumeStream     —— 读流、切帧、校验（zod）、交给 dispatch
 *   ③ dispatch          —— 19 种协议事件 → 页面状态
 */

export interface StreamExtras {
  /** sessionId 的 ref 镜像（断点续传要读最新值） */
  sessionIdRef: React.RefObject<string>;
  /** delta 分流目标 */
  deltaTargetRef: React.RefObject<{
    type: "card" | "scroll" | "teller";
    entryId?: string;
  } | null>;
  /** delta 缓冲（只写不渲染） */
  deltaBufferRef: React.RefObject<{
    reading: string;
    card: { entryId: string; text: string } | null;
    scroll: { entryId: string; text: string } | null;
    teller: string | null;
  }>;
  /** 安排一次 delta flush */
  scheduleDeltaFlush: () => void;
  /** 生成下一个条目 id */
  nextEntryId: () => string;
  /** 追加一条对话流条目 */
  pushEntry: (e: Omit<FlowEntry, "id"> & { id?: string }) => string;
}

export interface StreamRunnerApi {
  /** 消费一个 SSE 响应 */
  consumeStream: (res: Response) => Promise<void>;
  /** 取消在途的 SSE 请求 */
  abortStream: () => void;
  /** 断点续传（补发已错过的事件） */
  resumeStream: () => Promise<boolean>;
  /** 发起一次可取消的请求，返回 Response（调用方负责 consume） */
  fetchStream: (
    url: string,
    body: unknown,
    init?: { headers?: Record<string, string> }
  ) => Promise<Response>;
  /** 最后收到的 seq（断点续传用） */
  lastSeqRef: React.RefObject<number>;
}

export function useStreamRunner(
  state: DivinationStateApi,
  extras: StreamExtras
): StreamRunnerApi {
  /**
   * 在途 SSE 请求的取消句柄（P0-③）
   *
   * ⚠️ 为什么必须有（后端的断开检测形同虚设）：
   *   后端有完整的 `req.signal → client_disconnect → 停止烧 token` 逻辑，
   *   但前端 fetch **从不 abort** → req.signal 永远不触发 → 那段代码是死代码。
   *   后果：用户误点「重新开始」→ 旧流继续跑完整场仪式（14 次 LLM 往返）
   *   → 白烧约 ¥0.22 的 token，而且后端还把它记成"正常完成"。
   */
  const streamAbortRef = useRef<AbortController | null>(null);

  /** 最后收到的 SSE 事件序号（断点续传用，P1-③D） */
  const lastSeqRef = useRef(0);

  /**
   * ⚠️⚠️ 事件分发用 useEffectEvent 包装
   * · 永远读到最新的 state/extras，但**引用永不变**
   * · consumeStream 因此可以在依赖数组里放它 → 不会每次渲染重建 ✅
   */
  /**
   * ⚠️⚠️ state/extras 用 ref 镜像 —— 让 dispatch 的引用**永不变**
   * · 永远读到最新的 state/extras → dispatch 不会每次渲染重建
   * · consumeStream 因此可以安全地依赖它 → 下游 useCallback 不会失效 ✅
   *
   * ⚠️⚠️ 为什么 ref 在 **useEffect** 里写，而不是渲染期直接写：
   *   · eslint 的 `react-hooks/refs` 规则**禁止**渲染期写 ref.current（React 19 新规则）❌
   *   · 在 effect 里写是官方允许的写法 ✅
   *   · 时序安全：effect 在挂载后立即执行；本 hook 只在用户交互后被调用
   *     → 交互发生时 ref 早已同步 ✅
   *
   * ⚠️ 为什么不用 useEffectEvent：
   *   · 它的返回值**不能离开这个 hook**（不能传给 page.tsx / 不能被 useCallback 捕获）
   *     → eslint `react-hooks/rules-of-hooks` 明确禁止 ❌
   */
  const paramsRef = useRef({ state, extras });
  useEffect(() => {
    paramsRef.current = { state, extras };
  });

  const dispatch = useCallback((p: NonNullable<ReturnType<typeof parseAgentEvent>>) => {
    const {
      setSessionId, setPhase, setPhaseLabel, setRateLimited, setReasoning,
      setTools, setRagHits, setSpread, setAsk, setFanCards, setFanCount,
      setEntries, setSubagentEvents, setPlanSteps, setPersonaSuggest,
      setRounds, setReview, setError, setCanFollowup,
    } = paramsRef.current.state;
    const {
      sessionIdRef, deltaTargetRef, deltaBufferRef, scheduleDeltaFlush,
      nextEntryId, pushEntry,
    } = paramsRef.current.extras;

    switch (p.type) {
          case "session":
            setSessionId(p.sessionId);
            // P0-③：同步 ref 镜像（断点续传的 catch 块要读最新值）
            sessionIdRef.current = p.sessionId;
            // ⚠️ 2026-11-04：新会话刚建立 → 追问**一定可用**（还在内存里）
            setCanFollowup(true);
            // 持久化：刷新后可恢复会话继续追问（十几分钟的仪式流程不该因刷新作废）
            try { localStorage.setItem("tarot:sessionId", p.sessionId); } catch { /* 隐私模式 */ }
            break;
          case "phase":
            setPhase(p.phase ?? null);
            if (p.label) setPhaseLabel(p.label);              // 收束阶段：建"命运之卷"条目，后续收束 delta 流向它
            // （含 write_reading 综合正文与 close_reading 收束语）
            // P2-⑪：识别"限速等待"phase —— 让等待提示显示正确的原因
            if (p.label && p.label.includes("限流")) setRateLimited(true);
            /**
             * ⚠️ 2026-11-04 新增：阶段转换的"锣"音效
             * ⚠️ 目的：让用户感觉到"仪式在推进"（而不是"程序在等"）。
             * ⚠️ 只在**关键阶段**播（不是每个 phase 都播）——
             *    否则会变成噪音。关键节点 = 呼召 / 选牌 / 讲牌 / 综合 / 收束。
             */
            if (p.phase && STAGE_GONG_PHASES.includes(p.phase)) {
              void playSfx("gong");
            }
            if (p.label && (p.label.includes("收束") || p.label.includes("子 Agent 管线启动"))) {
              // 已有 scroll 条目则复用（收束语接在综合正文后）
              setEntries((prev) => {
                const lastScroll = [...prev].reverse().find((e) => e.kind === "scroll");
                if (lastScroll) {
                  deltaTargetRef.current = { type: "scroll", entryId: lastScroll.id };
                  return prev;
                }
                const sid = nextEntryId();
                deltaTargetRef.current = { type: "scroll", entryId: sid };
                return [...prev, { id: sid, kind: "scroll", title: "命运之卷 · 综合与收束", text: "", collapsed: false } as FlowEntry];
              });
            }
            break;
          case "nudge":
            // ⚠️ P1-⑧：HITL 等待中的分级提醒。
            //    渲染成一行低调小字（FlowEntryKind="nudge"）——
            //    刻意不用气泡：气泡会被当成"占卜师在说话"。
            //    同一条提醒只显示一次（level 1/2 各一条）。
            if (p.nudge) {
              setEntries((prev) => {
                const dup = prev.some((e) => e.kind === "nudge" && e.text === p.nudge!.text);
                if (dup) return prev;
                const sid = nextEntryId();
                return [...prev, { id: sid, kind: "nudge", text: p.nudge!.text } as FlowEntry];
              });
            }
            break;
          case "reasoning":
            setReasoning((prev) => (prev + p.reasoning).slice(-4000));
            break;
          case "tool":
            // ⚠️ 组件的 ToolCall 类型比 wire 格式更严（args/resultSummary/durationMs 非可选）。
            //    这里显式补默认值 —— 让"协议可选"与"视图必需"在边界处对齐，
            //    而不是把可选性传染给所有消费方。
            setTools((prev) => [
              ...prev,
              {
                name: p.tool.name,
                args: (p.tool.args ?? {}) as Record<string, unknown>,
                resultSummary: p.tool.resultSummary ?? "",
                durationMs: p.tool.durationMs ?? 0,
              },
            ]);
            // 冗余通道：rag_search 的 tool 事件也内嵌 ragHits，
            // 万一独立 rag_hits 事件丢失，前端仍能渲染知识面板
            if (p.tool?.name === "rag_search" && Array.isArray(p.ragHits)) {
              setRagHits(p.ragHits);
            }
            break;
          case "rag_hits":
            setRagHits(p.ragHits ?? []);
            break;
          case "cards":
            // ⚠️ 防剧透：cards 事件**只含位置**（id/nameZh/image 为空占位），
            //    牌名与图片要等用户亲手翻开（card_reveal）才补上。
            //    直接初始化 spread（对话流牌阵 + 顶部时间线 + 分享卡共用）。
            // 初始化牌阵（逐张手动翻牌）：全部牌背，第 0 张为"当前该翻的"
            if (Array.isArray(p.cards) && p.cards.length > 0) {
              const initial: SpreadCard[] = (p.cards as AgentCard[]).map((c, i) => ({
                index: i,
                id: c.id || `slot-${i}`,
                nameZh: c.nameZh ?? "",
                image: c.image ?? "",
                reversed: c.reversed,
                pos: c.pos,
                done: false,
                active: false,
                flipped: false,
                current: i === 0,
              }));
              setSpread(initial);
              // 牌阵面板插入对话流（常驻条目，后续原地更新状态）
              pushEntry({
                kind: "spread",
                spread: initial.map((c) => ({
                  index: c.index,
                  id: c.id,
                  nameZh: c.nameZh,
                  image: c.image,
                  reversed: c.reversed,
                  pos: c.pos,
                  flipped: c.flipped,
                  done: c.done,
                  current: c.current,
                })),
              });
            }
            break;
          case "ask_user":
            setAsk({
              question: p.ask.question,
              options: p.ask.options,
              cardSelection: p.cardSelection,
              crossroads: p.crossroads,
              kind: p.ask.kind,
            });
            if (p.cardSelection) {
              // 候选扇面由 ask_user 事件直接携带（7 张随机牌）
              if (Array.isArray(p.fanCards) && p.fanCards.length > 0) setFanCards(p.fanCards);
              setFanCount(p.fanCount ?? 3);
            }
            setPhase("wait_user");
            /**
             * ⚠️⚠️ 2026-11-04 新增：flip 事件**提前**把牌置为可点
             *
             * ⚠️ 用户实测报告："牌出现了，但有时候点的无效"。
             *   根因：后端的时序是
             *     await flipWait（闸门就绪）→ yield ask_user(flip) → yield card_flip_ready
             *   前端**只在 card_flip_ready 时**把该牌设为 current（可点）。
             *   两个事件之间有网络/调度间隙 → **牌已经显示，但点不动**。
             *   → 用户点了一下没反应 → 以为牌坏了。
             *
             *   修法：ask_user(kind=flip) 本身就意味着"现在该翻这张了"
             *        （后端是先建闸门、再发这个事件的，闸门此刻已就绪）
             *        → 在这里**提前**置 current，不等 card_flip_ready。
             *   ⚠️ card_flip_ready 事件仍保留（它是权威信号，会再置一次，幂等）。
             */
            if (p.ask?.kind === "flip") {
              setSpread((prev) => {
                if (prev.length === 0) return prev;
                // ⚠️ 找"第一张还没翻开的牌"（= 现在该翻的那张）
                const target = prev.findIndex((c) => !c.flipped && !c.flipping);
                if (target < 0) return prev;
                return prev.map((c, i) => ({ ...c, current: i === target }));
              });
            }
            // ---- 对话流映射 ----
            if (p.ask?.kind === "card_confirm") {
              // 牌面确认：挂到当前激活的 card 条目上
              setEntries((prev) => {
                const lastCard = [...prev].reverse().find((e) => e.kind === "card");
                if (!lastCard?.card) return prev;
                return prev.map((e) =>
                  e.id === lastCard.id
                    ? { ...e, card: { ...e.card!, question: p.ask.question, options: p.ask.options } }
                    : e
                );
              });
              /**
               * ⚠️⚠️ 2026-11-04 新增：把问题同步到**牌阵条目**
               *
               * ⚠️ 为什么必须同步：
               *   SpreadPanel 的自动展开逻辑要判断"牌上是否还有待回答的问题"
               *   （见 DialogueFlow 的 hasPendingCardQuestion）——
               *   否则用户回答牌面问题时，牌阵是**收起**的 → 看不到问题
               *   → 用户实测报告的"还要重新手动打开选择"。
               *
               * ⚠️ 同步到**哪一张**：刚翻开的那张（最后一张已翻开的牌）。
               *   ⚠️ 不能用 "current"（card_reveal 已把它清空了）。
               */
              const q = p.ask.question;
              setEntries((prev) => {
                const lastFlipped = [...prev]
                  .reverse()
                  .find((e) => e.kind === "spread" && e.spread && e.spread.some((c) => c.flipped));
                if (!lastFlipped?.spread) return prev;
                return prev.map((e) =>
                  e.id === lastFlipped.id
                    ? {
                        ...e,
                        spread: e.spread!.map((c) => {
                          // ⚠️ 只给"最后一张已翻开的牌"挂问题（还没答的那张）
                          if (!c.flipped) return c;
                          const alreadyAnswered = !!c.answer;
                          return alreadyAnswered ? c : { ...c, question: q };
                        }),
                      }
                    : e
                );
              });
            } else {
              // 其余（承约/呼召/澄清/岔路/收束/继续）：插入待回答条目
              pushEntry({
                kind: "ask",
                ask: {
                  question: p.ask.question,
                  options: p.ask.options,
                  kind: p.ask.kind,
                  cardSelection: p.cardSelection,
                  crossroads: p.crossroads,
                },
              });
            }
            break;
          /* ---- 真实塔罗仪式流程事件（同时映射进对话流） ---- */
          case "contract":
            // 对话流：占卜师说承约语（问题本身由随后的 ask_user 事件建面板）
            if (p.contract) {
              pushEntry({
                kind: "teller",
                text: `我听到的是——${p.contract.question}${p.contract.scope ? `\n（本次牌阵：${p.contract.scope}）` : ""}`,
              });
            }
            break;
          case "invocation":
            // 对话流：呼召由随后的 ask_user（kind=invocation）建三问面板
            break;
          case "card_reveal": {
            const r = p.cardReveal;
            if (r) {
              // ⚠️ 2026-11-04 新增：牌面揭示的"磬"音效
              // ⚠️ 这是整个仪式里**最重要的一下**（用户亲手翻开，牌面第一次显现）
              //    → 值得一个带长混响尾的磬声。
              void playSfx("reveal");
              // 更新牌阵：这张牌已翻开（flipped=true）→ 显示牌面
              // ⚠️ 牌名/图片此刻才补上（cards 事件只给了位置，防剧透）
              // ⚠️ 同时清掉所有 current：这张已经翻开了，"当前该翻的"
              //    应该是**下一张**（由随后的 card_flip_ready 置上）。
              //    不清的话 current 会一直挂在刚翻开的这张上 →
              //    牌阵面板在"模型正在输出解读"期间也保持展开，挡住正文
              //    （用户诉求：大模型输出时自动收起翻牌面板）。
              setSpread((prev) => {
                const list = prev.length > 0 ? prev : [];
                const next = list.map((c, i) =>
                  i === r.cardIndex
                    // ⚠️ flipping: false —— 乐观翻转动画在此**落定**
                    //   （点击时本地先转 90°，后端事件到了才补牌面）
                    ? { ...c, flipped: true, active: true, current: false, flipping: false, nameZh: r.nameZh, image: r.image, reversed: r.reversed }
                    : { ...c, active: false, current: false }
                );
                if (next.length === 0) {
                  // 首次收到：构造完整牌阵（当前牌 + 后续待翻）
                  return [{ ...r, index: r.cardIndex, done: false, active: true, flipped: true, current: false, flipping: false } as SpreadCard];
                }
                return next;
              });
              // 牌面已下发 → 同步到牌阵面板条目（牌名/牌意此时才可见）
              // ⚠️ 同时清掉 current（与上面 setSpread 一致）：
              //    翻开的这张不再是"当前该翻的"，牌阵面板据此自动收起，
              //    等下一张的 card_flip_ready 到达再自动展开。
              setEntries((prev) =>
                prev.map((e) =>
                  e.kind === "spread" && e.spread
                    ? {
                        ...e,
                        spread: e.spread.map((c) =>
                          c.index === r.cardIndex
                            ? { ...c, flipped: true, current: false, nameZh: r.nameZh, image: r.image, reversed: r.reversed, meaning: r.meaning }
                            : { ...c, current: false }
                        ),
                      }
                    : e
                )
              );
              // 翻牌闸门的提示面板已过期 → 收掉它。
              // ⚠️ 但**不能覆盖用户说的话**：若用户是通过闸门输入框插话
              //    （"我未来那段——那团火"），answerFlowAsk 已把该条目
              //    settle 成用户气泡 —— 此处若再改写文案，会把用户的话
              //    覆盖成"✦ 你翻开了这张牌"（实测报告：用户的话消失了）。
              //    只处理**仍未 settle** 的（用户是点牌完成的）。
              setEntries((prev) =>
                prev.map((e) =>
                  e.kind === "ask" && !e.settled && e.ask?.kind === "flip"
                    ? { ...e, settled: true, kind: "teller", text: "✦ 你翻开了这张牌", ask: undefined }
                    : e
                )
              );
              // ---- 对话流：新建 card 条目（念牌内容直接带上）----
              const entryId = nextEntryId();
              pushEntry({
                id: entryId,
                kind: "card",
                card: {
                  cardIndex: r.cardIndex,
                  nameZh: r.nameZh,
                  image: r.image,
                  reversed: r.reversed,
                  pos: r.pos,
                  narrative: r.narrative,
                  meaning: r.meaning,
                  revealed: true,
                  readingDone: false,
                },
              });
              // 后续该牌的解读 delta 流向这个条目
              deltaTargetRef.current = { type: "card", entryId };
              // 翻新牌时：把之前的牌折叠为摘要行（保持时间线整洁）
              setEntries((prev) =>
                prev.map((e) =>
                  e.kind === "card" && e.card && e.card.cardIndex !== r.cardIndex && e.card.readingDone && !e.collapsed
                    ? { ...e, collapsed: true }
                    : e
                )
              );
            }
            break;
          }
          case "card_reading": {
            const cr = p.cardReading;
            if (cr) {
              setSpread((prev) => prev.map((c, i) => (i === cr.cardIndex ? { ...c, done: true, active: false } : c)));
              // 牌阵面板同步：这张牌解读完成（金框 + ✓）
              setEntries((prev) =>
                prev.map((e) =>
                  e.kind === "spread" && e.spread
                    ? { ...e, spread: e.spread.map((c) => (c.index === cr.cardIndex ? { ...c, done: true } : c)) }
                    : e
                )
              );
              // ---- 对话流：标记该牌解读完成 ----
              // ⚠️ **不再覆盖 reading**：正文已由 delta 流式累积到 e.card.reading。
              //    旧设计用 cr.text 覆盖 → 与 delta 缓冲形成双数据源，
              //    rAF 分帧竞争时残留 delta 被追加一次 → 整段输出两遍
              //    （用户实测报告）。这里只置完成标记，正文只由 delta 写。
              setEntries((prev) =>
                prev.map((e): FlowEntry => {
                  if (e.kind !== "card" || e.card?.cardIndex !== cr.cardIndex) return e;
                  return { ...e, card: { ...e.card!, readingDone: true }, collapsed: false };
                })
              );
              deltaTargetRef.current = null;
            }
            break;
          }
          /* ---- 逐张翻牌闸门：第 N 张可以翻了（⚠️ 事件不含牌面，防剧透）---- */
          case "card_flip_ready": {
            const fr = p.cardFlipReady;
            if (fr) {
              // 顶部时间线：标记该张为"当前该翻的"，其余取消 current
              setSpread((prev) =>
                prev.map((c, i) =>
                  i === fr.cardIndex
                    ? { ...c, current: true, flipping: false }
                    : { ...c, current: false }
                )
              );
              // 牌阵面板同步（此时牌名仍未下发 —— 未翻开的牌显示 "？"）
              setEntries((prev) =>
                prev.map((e) =>
                  e.kind === "spread" && e.spread
                    ? { ...e, spread: e.spread.map((c) => (c.index === fr.cardIndex ? { ...c, current: true } : { ...c, current: false })) }
                    : e
                )
              );
            }
            break;
          }
          case "subagent":
            setSubagentEvents((prev) => [...prev, p.subagent]);
            break;
          /* 方向⑤：Plan-Execute 计划 / 情绪人格建议 */
          case "plan":
            setPlanSteps(p.plan ?? []);
            break;
          case "persona_suggest":
            setPersonaSuggest(p.personaSuggest ?? null);
            break;
          case "round":
            setRounds((prev) => [...prev, p.round]);
            break;
          case "review":
            // ⚠️ 组件的 ReviewData 要求 comment 非空 —— 协议里是可选的
            //    （解析失败时 review.comment 仍会给一个说明，但协议层允许缺省）。
            //    在边界处补默认值，不把可选性传染给消费方。
            setReview({
              pass: p.review.pass,
              scores: p.review.scores,
              comment: p.review.comment ?? "",
              rewritten: p.review.rewritten,
            });
            break;
          case "delta": {
            const d = p.delta ?? "";
            if (!d) break;
            // ---- 节流：只写缓冲，rAF 统一 flush（见 deltaBufferRef） ----
            const target = deltaTargetRef.current;
            deltaBufferRef.current.reading += d; // 完整正文仍累积（分享卡/落库用）
            if (target?.type === "card" && target.entryId) {
              const t = target.entryId;
              // 同帧多条 delta 合并进同一目标
              if (deltaBufferRef.current.card?.entryId === t) {
                deltaBufferRef.current.card.text += d;
              } else {
                deltaBufferRef.current.card = { entryId: t, text: d };
              }
            } else if (target?.type === "scroll" && target.entryId) {
              const t = target.entryId;
              if (deltaBufferRef.current.scroll?.entryId === t) {
                deltaBufferRef.current.scroll.text += d;
              } else {
                deltaBufferRef.current.scroll = { entryId: t, text: d };
              }
            } else {
              // 无目标：占卜师的开场白/回应 → teller 气泡
              deltaBufferRef.current.teller = (deltaBufferRef.current.teller ?? "") + d;
            }
            scheduleDeltaFlush();
            break;
          }
          case "done":
            setPhase("done");
            break;
          case "error":
            setError(p.error);
            break;
        }
  }, []);

  /**
   * SSE 消费 —— 支持断点续传（P1-③）
   *
   * ⚠️ 断点续传：
   *   后端给每个事件带 SSE 标准 `id: <seq>` 字段。
   *   这里记录最后收到的 seq；流意外中断时（网络抖动），
   *   用 `Last-Event-ID` + `resume: true` 请求后端补发错过的事件。
   *
   * ⚠️ 为什么不用 EventSource：
   *   EventSource 只能 GET，不能带自定义 body（POST /api/interpret）。
   *   所以用 fetch + ReadableStream 手动解析 SSE 帧。
   */
  /**
   * ⚠️ consumeStream 用 useCallback（引用稳定 → 可交给 page.tsx）
   * · dispatch 引用稳定 → 依赖数组里放它没问题 ✅
   */
  const consumeStream = useCallback(async (res: Response) => {
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "解读失败" }));
        throw new Error(err.error || "解读失败");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { frames, remainder } = splitSseFrames(buf);
        buf = remainder;
        for (const { seq, data: dataLine } of frames) {
          // 记录最后收到的 seq（断点续传用）
          if (seq > 0) lastSeqRef.current = seq;
          try {
            // ⚠️ zod schema 解析（前后端单一事实源）：
            //    协议不匹配时返回 null → 跳过这一条，**不丢弃整场对话**。
            //    之前这里是 JSON.parse + any，字段写错要到渲染时才炸。
            const p = parseAgentEvent(dataLine);
            if (!p) continue;
            dispatch(p);
          } catch {
            /* 忽略 */
          }
        }
      }
  }, [dispatch]);

  /** 取消在途的 SSE 请求（P0-③） */
  const abortStream = useCallback(() => {
    const ctrl = streamAbortRef.current;
    if (ctrl) {
      ctrl.abort();
      streamAbortRef.current = null;
    }
  }, []);

  /**
   * 发起一次可取消的请求
   * ⚠️ 每次都会先取消上一个（保证同一时刻只有一个 SSE 流）
   */
  const fetchStream = useCallback(
    async (
      url: string,
      body: unknown,
      init?: { headers?: Record<string, string> }
    ): Promise<Response> => {
      abortStream();
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    },
    [abortStream]
  );

  /**
   * 断点续传（P1-③）
   *
   * ⚠️ 语义：只补发**已经产生过**的事件（后端有缓冲区）。
   *    后端 agent 若已跑完，补发后用户能看到完整对话；
   *    若还在跑，会继续推送（用户可以继续回答 HITL）。
   *
   * @returns 是否成功恢复
   */
  const resumeStream = useCallback(async (): Promise<boolean> => {
    // ⚠️ P0-③：读 **ref** 而不是 state 闭包
    //    （startDivination 的 catch 块在同一调用栈内执行，
    //      state 闭包捕获的是"启动时刻"的 = 空串 → 恢复分支永远进不去）
    const sid = extras.sessionIdRef.current;
    if (!sid || lastSeqRef.current === 0) return false;
    try {
      // P0-③：恢复请求也要有 AbortController（用户可能在恢复途中点「重新开始」）
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // SSE 标准头：告诉后端客户端最后收到哪个事件
          "Last-Event-ID": String(lastSeqRef.current),
        },
        body: JSON.stringify({ sessionId: sid, resume: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) return false;
      await consumeStream(res);
      return true;
    } catch (e) {
      // ⚠️ 被主动取消 → 不是错误，不该弹"解读失败"
      if (e instanceof DOMException && e.name === "AbortError") return false;
      return false;
    } finally {
      streamAbortRef.current = null;
    }
  }, [consumeStream, extras.sessionIdRef]);

  return {
    consumeStream,
    abortStream,
    resumeStream,
    fetchStream,
    lastSeqRef,
  };
}
