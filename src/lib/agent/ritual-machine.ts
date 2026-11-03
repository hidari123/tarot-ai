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
  contract: ["contract", "invocation"],       // 可重复承约（幂等守卫另管）
  invocation: ["invocation", "contract", "card_selection"], // 可回退重做承约
  card_selection: ["card_selection", "contract", "invocation", "per_card"],
  per_card: ["per_card", "card_selection", "synthesis"],   // 可回退重新选牌
  synthesis: ["synthesis", "closing"],
  closing: ["closing", "done"],
  done: ["done"],                              // 终态
};

/** 转移是否合法 */
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
 * @param current 当前正在进行的阶段
 * @param target  目标阶段
 * @param completed 已完成的阶段集合（用于判断前置是否齐备）
 * @param ctx     上下文（用于生成具体提示）
 */
export function canEnter(
  current: RitualPhase,
  target: RitualPhase,
  completed: Set<RitualPhase> = new Set(),
  ctx: { toolName?: string } = {}
): GuardResult {
  // 目标阶段的前置阶段（按顺序）
  const targetIdx = phaseIndex(target);
  const prerequisites = RITUAL_ORDER.slice(0, targetIdx);

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
      hint: `${tool} 暂时不能进行：当前处于「${RITUAL_PHASE_LABEL[current]}」阶段，不能直接进入「${RITUAL_PHASE_LABEL[target]}」。${nextActionHint(current)}`,
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
}): Set<RitualPhase> {
  const done = new Set<RitualPhase>();
  if (s.contractQuestion) done.add("contract");
  if (s.invocation?.answers?.length) done.add("invocation");
  if (s.drawnCards?.length) done.add("card_selection");
  const cards = s.drawnCards?.length ?? 0;
  const readings = s.cardReadings ?? [];
  if (cards > 0 && readings.filter((r) => r.reading).length >= cards) done.add("per_card");
  if (s.finished) {
    done.add("synthesis");
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
 * 当前阶段的"下一步该做什么"（给模型的引导语）
 *
 * ⚠️ 用在"轮次逼近上限"这类需要催模型的场合 ——
 *   比笼统的"请继续"具体得多，模型更不容易跑偏。
 */
export function nextActionHint(phase: RitualPhase): string {
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
