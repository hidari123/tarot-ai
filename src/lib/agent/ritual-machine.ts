/**
 * 占卜仪式状态机（P1-⑩）
 *
 * ⚠️ 为什么要有这个模块（之前的问题）：
 *   仪式进度以前靠**隐式判断** —— 看几个字段是不是空：
 *     if (!session.contractQuestion) → 还没承约
 *     if (!session.invocation?.answers?.length) → 还没呼召
 *     if (session.drawnCards.length === 0) → 还没抽牌
 *   这有三个具体危害：
 *     1. **逻辑重复**：同样的判断在 supervisor 里出现了 4 次（两个抽牌入口各 2 次），
 *        改一处忘另一处 → 守卫漏防，模型就能跳步。
 *     2. **状态不可见**：会话进行到哪一步？只能靠反推字段 ——
 *        dashboard 想知道"这场占卜卡在承约还是翻牌"都得自己拼。
 *     3. **无法穷举**：合法转移没被显式描述，
 *        就没法写"状态机测试"（比如"呼召未完成不能进抽牌"）。
 *
 * ⚠️ 核心设计：
 *   1. **状态是显式的**：session.ritualPhase 明确记录当前处于哪个阶段。
 *   2. **转移表是数据**：合法转移写成一张表，不是散落的 if。
 *   3. **守卫统一入口**：所有"能不能做 X"的判断走 canEnter()，
 *      拿不到就返回**可执行的修复提示**（告诉模型下一步该做什么）。
 *   4. **状态可从旧会话推导**：老会话没有 ritualPhase 字段，
 *      用 derivePhase() 从已有字段反推 —— 不用数据迁移。
 *
 * ⚠️ 为什么不用状态机库（xstate 等）：
 *   本项目的"状态"是**业务流程的进度**，不是 UI 状态；
 *   转移是线性的（承约→呼召→选牌→逐张讲→综合→收束），
 *   偶尔有回退（承约被用户否定 → 重做承约）。
 *   引入库要付出学习成本 + 序列化负担，
 *   而一张 30 行的转移表足够，且更好读。
 */

import { requiredPhases, type DivinationMode } from "./divination-mode";

/* ------------------------------------------------------------------ */
/* 状态定义                                                            */
/* ------------------------------------------------------------------ */

/**
 * 仪式阶段
 *
 * ⚠️ 命名用"阶段"而非"步骤"：因为翻牌/讲牌会重复 N 次（每张牌一轮），
 * 用 Step 容易误解成线性推进。
 */
export type RitualPhase =
  | "contract"        // 承约：复述问题请用户确认
  | "invocation"      // 呼召：用户回答三问
  | "card_selection"  // 选牌：用户亲手选
  | "per_card"        // 逐张解读：翻牌 → 讲牌（可重复）
  | "synthesis"       // 综合：analyst → writer → reviewer 管线
  | "closing"         // 收束：收尾语 + 行动建议 + 收尾追问
  | "done";           // 完成

/** 各阶段的中文名（dashboard / 日志用） */
export const RITUAL_PHASE_LABEL: Record<RitualPhase, string> = {
  contract: "承约",
  invocation: "呼召",
  card_selection: "选牌",
  per_card: "逐张解读",
  synthesis: "综合",
  closing: "收束",
  done: "完成",
};

/**
 * 阶段顺序（用于判断"是否跳过"）
 *
 * ⚠️ 为什么要显式定义顺序：
 *   守卫判断"能不能进入 X 阶段"时，需要知道 X 之前有哪些必经阶段。
 *   之前这个知识散在 if 语句里，现在集中在这里。
 */
export const RITUAL_ORDER: RitualPhase[] = [
  "contract",
  "invocation",
  "card_selection",
  "per_card",
  "synthesis",
  "closing",
  "done",
];

/** 某阶段的序号（用于比较早晚） */
export function phaseIndex(p: RitualPhase): number {
  return RITUAL_ORDER.indexOf(p);
}

/**
 * 工具 → 必需阶段（P2-⑨）
 *
 * ⚠️ 这张表是"仪式不许跳步"的**单一事实源**。
 *   审计实测：守卫原本只覆盖 2 个工具（offer_card_selection / draw_cards），
 *   其余 6 个仪式工具完全没有前置检查 → 模型可以：
 *     · 不承约直接 reveal_card
 *     · 不抽牌直接 interpret_card
 *     · 不逐张讲完直接 write_reading（综合没依据）
 *   实测证据：32/34 条 eval 用例的 contract/invocation/percard/closing 全缺。
 *
 * ⚠️ 语义：值 = "调用这个工具时，**至少要处于**哪个阶段"
 *   （canEnter 会用 completedPhases 检查该阶段的前置是否齐备）。
 *
 * ⚠️ 为什么 ask_user / rag_search 不在表里：
 *   它们是**任何阶段都能调用**的自由工具（澄清提问、查典籍）。
 *   把它们加进守卫会阻断合法的"边查边问"。
 */
export const TOOL_PHASE_REQUIREMENT: Record<string, RitualPhase> = {
  /** 承约：从头开始（无前置） */
  establish_contract: "contract",
  /** 呼召：需要承约已完成 */
  invoke_three_questions: "invocation",
  /** 选牌：需要承约 + 呼召 */
  offer_card_selection: "card_selection",
  /** 抽牌（代抽）：需要承约 + 呼召 */
  draw_cards: "card_selection",
  /** 翻牌：需要已选牌 */
  reveal_card: "per_card",
  /** 讲牌：需要已翻牌（牌面必须先揭示才能解读） */
  interpret_card: "per_card",
  /**
   * 讲牌（批量版，快速模式专用）
   * ⚠️ 2026-11-04：与 interpret_card 同样的前置（已翻牌）
   *   —— 批量工具也必须建立在"牌已揭示"之上，否则模型会凭空讲牌。
   */
  interpret_all_cards: "per_card",
  /** 综合：需要逐张解读完成 */
  write_reading: "synthesis",
  /** 收束：需要综合完成 */
  close_reading: "closing",
};

/* ------------------------------------------------------------------ */
/* 转移表                                                              */
/* ------------------------------------------------------------------ */

/**
 * 允许的阶段转移
 *
 * ⚠️ 为什么是"表"而不是"if"：
 *   表可以穷举、可以打印、可以测试。
 *   if 散落在各处，永远会漏掉一条路径。
 *
 * ⚠️ 允许的回退：
 *   contract → invocation 是**正常推进**
 *   invocation → contract 是**回退**（用户否定了承约 → 重新确认）
 *   card_selection → contract 同理（用户想改问题）
 */
const ALLOWED_TRANSITIONS: Record<RitualPhase, RitualPhase[]> = {
  // ⚠️ contract → card_selection 是**快速模式**的路径（跳过呼召三问）
  contract: ["contract", "invocation", "card_selection"], // 可重复承约（幂等守卫另管）
  invocation: ["invocation", "contract", "card_selection"], // 可回退重做承约
  card_selection: ["card_selection", "contract", "invocation", "per_card"],
  per_card: ["per_card", "card_selection", "synthesis"],   // 可回退重新选牌
  synthesis: ["synthesis", "closing"],
  closing: ["closing", "done"],
  done: ["done"],                              // 终态
};

/**
 * 转移是否合法
 *
 * ⚠️ 为什么**不**按模式收紧（比如"快速模式禁止进入 invocation"）：
 *   转移表表达的是"流程上可达"，而"该不该走这一步"由**守卫的前置集合**决定
 *   （见 canEnter + requiredPhases）。
 *   如果这里按模式收紧，快速模式一旦模型误调 invoke_three_questions，
 *   守卫会给出"非法转移"而不是"这个模式不需要这一步"—— 提示会误导模型。
 *   → 模式相关的拦截统一放在 canEnter 与 supervisor 的工具分发层。
 */
export function canTransition(from: RitualPhase, to: RitualPhase): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/* ------------------------------------------------------------------ */
/* 守卫：能不能进入某个阶段                                            */
/* ------------------------------------------------------------------ */

/**
 * 守卫结论
 *
 * ⚠️ 为什么返回"修复提示"而不是单纯的 false：
 *   守卫拦下模型时，必须告诉它**下一步该做什么** ——
 *   只说"不行"的话，模型会反复尝试同一个非法动作（实测：会死循环）。
 *   提示语直接可以塞进 tool response。
 */
export interface GuardResult {
  ok: boolean;
  /** 不通过时：缺哪个阶段 */
  missing?: RitualPhase;
  /** 不通过时：给模型的修复提示 */
  hint?: string;
}

/**
 * 判断能否进入目标阶段。
 *
 * ⚠️ 语义澄清（这里踩过坑，值得写清楚）：
 *   `current` 表示"**当前正在进行的阶段**"，不是"已完成到哪"。
 *   所以 current="contract" 有两种含义：
 *     a) 承约正在做（还没完成）
 *     b) 承约刚做完，正准备进下一步
 *   光看 current 无法区分 —— 所以守卫需要**两个信息**：
 *     - current：当前处于哪个阶段
 *     - completed：哪些阶段已经**完成**
 *   完成情况由调用方根据实际进度推导（承约定稿了？呼召拿到答案了？牌抽了？）。
 *
 * ⚠️⚠️ mode 参数（2026-11-04 双模式）：
 *   快速模式跳过呼召 → `invocation` 永远不会出现在 completed 里。
 *   如果这里检查**全部**前置，选牌会被**永久拦截**（守卫死锁）。
 *   → 按模式过滤前置集合（见 divination-mode.ts 的 requiredPhases）。
 *   ⚠️ 默认 "deep" → 老会话（无 mode 字段）行为完全不变。
 *
 * @param current 当前正在进行的阶段
 * @param target  目标阶段
 * @param completed 已完成的阶段集合（用于判断前置是否齐备）
 * @param ctx     上下文（用于生成具体提示）
 * @param mode    占卜模式（决定哪些阶段是必需的）
 */
export function canEnter(
  current: RitualPhase,
  target: RitualPhase,
  completed: Set<RitualPhase> = new Set(),
  ctx: { toolName?: string } = {},
  mode: DivinationMode = "deep"
): GuardResult {
  // 目标阶段的前置阶段（按顺序）—— ⚠️ 只保留**该模式要求**的前置
  const targetIdx = phaseIndex(target);
  const required = requiredPhases(mode);
  const prerequisites = RITUAL_ORDER.slice(0, targetIdx).filter((p) => required.has(p));

  // 找出第一个未完成的前置阶段
  const missing = prerequisites.find((p) => !completed.has(p));

  // ⚠️ 关键：**当前阶段本身如果就是缺失的前置**，
  //    说明"这一步还没做完就想往下走" —— 提示必须指向它自己。
  //    例：承约还没定稿就想抽牌 → 缺「承约」（不是「呼召」）。
  if (missing) {
    const tool = ctx.toolName ?? "该工具";
    const hints: Record<RitualPhase, string> = {
      contract: "请先调用 establish_contract —— 把用户的问题复述成一个更具体、能被牌回答的问题，并声明牌阵范围，请用户确认。真实占卜师绝不会跳过这一步。",
      invocation: "请先调用 invoke_three_questions —— 请用户回答「想知道什么 / 打算做什么 / 需要防什么」。这三个回答是后续解读的骨架。",
      card_selection: "请先调用 offer_card_selection（用户亲手选，仪式感最强）或 draw_cards（用户没耐心时）。",
      per_card: "请先抽牌，然后对每张牌依次调用 reveal_card（念牌+等用户回答）与 interpret_card（讲透这一张）。",
      synthesis: "请先对所有牌完成 reveal_card + interpret_card，全部讲完后才能调用 write_reading 做最终综合。",
      closing: "请先调用 write_reading 完成最终综合。",
      done: "仪式已经完成了。",
    };
    return {
      ok: false,
      missing,
      hint: `${tool} 暂时不能进行：「${RITUAL_PHASE_LABEL[missing]}」这一步还没完成。${hints[missing]}`,
    };
  }

  // 前置都齐了 —— 再看转移是否合法（防止乱跳）
  if (!canTransition(current, target)) {
    const tool = ctx.toolName ?? "该工具";
    return {
      ok: false,
      missing: current,
      hint: `${tool} 暂时不能进行：当前处于「${RITUAL_PHASE_LABEL[current]}」阶段，不能直接进入「${RITUAL_PHASE_LABEL[target]}」。${nextActionHint(current, mode)}`,
    };
  }

  return { ok: true };
}

/**
 * 从会话现状推导"已完成阶段集合"
 *
 * ⚠️ 为什么要有这个函数（而不是让调用方自己判断）：
 *   "什么算完成"的定义散落在各处会漂移 ——
 *   承约算完成的标志是 contractQuestion 有值，
 *   呼召算完成的标志是 invocation.answers 非空，
 *   选牌算完成的标志是 drawnCards 非空 ……
 *   集中在这里，守卫和状态推导共用同一套判据。
 */
export function completedPhases(s: {
  finished?: boolean;
  contractQuestion?: string | null;
  invocation?: { answers?: string[] } | null;
  drawnCards?: unknown[];
  cardReadings?: Array<{ reading?: string }>;
  /** P2-⑨：综合是否已完成（write_reading 结束时置位） */
  synthesisDone?: boolean;
}): Set<RitualPhase> {
  const done = new Set<RitualPhase>();
  if (s.contractQuestion) done.add("contract");
  if (s.invocation?.answers?.length) done.add("invocation");
  if (s.drawnCards?.length) done.add("card_selection");
  const cards = s.drawnCards?.length ?? 0;
  const readings = s.cardReadings ?? [];
  if (cards > 0 && readings.filter((r) => r.reading).length >= cards) done.add("per_card");
  // ⚠️ P2-⑨：synthesis 的完成标志是"综合正文已产出"，
  //    **不是** finished（会话结束）。
  //    原因：close_reading 的守卫要求 synthesis 已完成，
  //    而 close_reading 发生在会话结束**之前** ——
  //    如果用 finished 判断，守卫会永远拦截（收束语永远不生成）。
  if (s.synthesisDone) done.add("synthesis");
  if (s.finished) {
    done.add("closing");
    done.add("done");
  }
  return done;
}


/* ------------------------------------------------------------------ */
/* 阶段推导与推进                                                      */
/* ------------------------------------------------------------------ */

/**
 * 从会话现有字段推导仪式阶段。
 *
 * ⚠️ 为什么需要（向后兼容）：
 *   老会话（快照里没有 ritualPhase）如果直接当成 "contract"，
 *   会导致**恢复后被守卫拦住**（用户看到"请先承约"，但其实已经承约过了）。
 *   所以老会话必须从已有字段反推真实进度。
 *
 * 推导顺序 = 仪式的自然顺序，从后往前找"已完成的最靠后阶段"：
 *   closing 完成？ → synthesis 完成？ → 逐张讲完？ → 抽牌了？ → 呼召了？ → 承约了？
 */
export function derivePhase(s: {
  finished?: boolean;
  contractQuestion?: string | null;
  invocation?: { answers?: string[] } | null;
  drawnCards?: unknown[];
  /**
   * 已完成的牌解读
   * ⚠️ 只看 `reading` 字段（解读正文是否已产出）——
   *    `reveal` 是对象（念牌内容），不是布尔，别拿它判断"讲完了"。
   */
  cardReadings?: Array<{ reading?: string }>;
}): RitualPhase {
  if (s.finished) return "done";

  const cards = s.drawnCards?.length ?? 0;
  const readings = s.cardReadings ?? [];
  const allRead = cards > 0 && readings.filter((r) => r.reading).length >= cards;

  if (allRead) return "synthesis";
  if (cards > 0) return "per_card";
  if (s.invocation?.answers?.length) return "card_selection";
  if (s.contractQuestion) return "invocation";
  return "contract";
}

/**
 * 推进阶段（只在合法转移时推进）
 *
 * ⚠️ 为什么不直接赋值：非法转移（比如 per_card → done）
 *    会让状态机失去意义 —— 守卫是基于阶段判断的。
 *    非法时返回 false，让调用方记录日志。
 */
export function advance(current: RitualPhase, target: RitualPhase): { ok: boolean; phase: RitualPhase } {
  if (!canTransition(current, target)) return { ok: false, phase: current };
  return { ok: true, phase: target };
}

/**
 * 推进阶段并**记录非法转移**（P2-⑨）
 *
 * ⚠️ 为什么需要这个包装（审计实测的 8 处静默失败）：
 *   supervisor 里有 8 处 `advance(...).phase` —— 全部**丢弃了 `.ok`**。
 *   而 advance() 在非法转移时返回 `{ok: false, phase: current}` ——
 *   也就是"原地不动"，**没有任何声音**。
 *   后果：状态机形同虚设 ——
 *     · 阶段跳过了（contract → done）→ 守卫基于阶段判断 → 全线失守
 *     · 而且**日志里看不到任何异常** → 排查时完全看不出发生了什么
 *   这个包装把 `.ok` 用起来：非法转移 → 打日志（可观测）+ 保持原阶段。
 *
 * ⚠️ 为什么不在 advance() 内部直接打日志：
 *   那样会掩盖"调用方忽略了返回值"这个事实 ——
 *   调用方本可以自己处理（比如拒绝这次转移并给模型反馈），
 *   但它们都没处理。**在调用点暴露问题**才是对的设计。
 *
 * @param sessionId 用于日志定位
 */
export function advancePhase(
  sessionId: string,
  current: RitualPhase,
  target: RitualPhase
): RitualPhase {
  const r = advance(current, target);
  if (!r.ok) {
    console.error(
      `[ritual] 非法阶段转移：${current} → ${target}（会话 ${sessionId}）—— 已保持原阶段`
    );
  }
  return r.phase;
}

/**
 * 当前阶段的"下一步该做什么"（给模型的引导语）
 *
 * ⚠️ 用在"轮次逼近上限"这类需要催模型的场合 ——
 *   比笼统的"请继续"具体得多，模型更不容易跑偏。
 *
 * ⚠️ mode（2026-11-04 双模式）：快速模式不需要呼召 ——
 *   如果在这里提示"请调用 invoke_three_questions"，
 *   模型会去调用一个**守卫不要求**、用户也不想要的工具 → 多问一轮，破坏体验。
 */
export function nextActionHint(phase: RitualPhase, mode: DivinationMode = "deep"): string {
  if (mode === "quick") {
    const quickHints: Record<RitualPhase, string> = {
      contract: "现在应该先调用 establish_contract 与用户确认问题。",
      // ⚠️ 快速模式：跳过呼召，直接选牌
      invocation: "现在是快速模式 —— 不要调用 invoke_three_questions，直接进入选牌。",
      card_selection: "现在应该调用 offer_card_selection 让用户亲手选牌。",
      per_card: "现在应该把已翻开的牌一次讲完（可一次传多张牌给 interpret_card）。",
      synthesis: "现在应该调用 write_reading 做最终综合。",
      closing: "现在应该调用 close_reading 做收束。",
      done: "仪式已完成，等待用户后续追问。",
    };
    return quickHints[phase];
  }
  const hints: Record<RitualPhase, string> = {
    contract: "现在应该先调用 establish_contract 与用户确认问题。",
    invocation: "现在应该调用 invoke_three_questions 请用户回答三问。",
    card_selection: "现在应该调用 offer_card_selection 让用户亲手选牌。",
    per_card: "现在应该逐张 reveal_card + interpret_card —— 翻一张、讲一张。",
    synthesis: "现在应该调用 write_reading 做最终综合。",
    closing: "现在应该调用 close_reading 做收束。",
    done: "仪式已完成，等待用户后续追问。",
  };
  return hints[phase];
}
