"use client";

import { memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * 对话流视图 —— 整场占卜的统一时间线
 *
 * 设计原则（对应"真实塔罗师"体验）：
 *   1. 问题与回答永远相邻：ask 面板作为"待回答条目"插入流中，
 *      答完固定为用户气泡，占卜师的回应紧随其后
 *   2. 每张牌是一个"段落单元"：翻牌 → 念牌 → 确认问答 → 解读，
 *      完成后折叠为一行摘要（可点开看全部，再点收起）
 *   3. 节奏交给用户：每张牌解读完出现"翻下一张"按钮，不自动连播
 *   4. 自动滚动只作用于本容器，用户上滚时暂停
 */

/* ---------------- 类型 ---------------- */

export type FlowEntryKind =
  | "teller"          // 占卜师说的话（气泡）
  | "user"            // 用户的回答/选择（气泡）
  | "ask"             // 待回答的问题面板（答完转为 user 条目）
  | "card"            // 一张牌的完整段落（翻牌+念牌+问答+解读，可折叠）
  | "scroll";         // 命运之卷（最终总结/全文卡片）

export interface FlowCardData {
  cardIndex: number;
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
  /** 念牌：牌面叙述 */
  narrative?: string;
  /** 念牌：典籍牌意 */
  meaning?: string;
  /** 确认问题 */
  question?: string;
  options?: string[];
  /** 用户回答 */
  answer?: string;
  /** 解读全文 */
  reading?: string;
  /** 状态 */
  revealed: boolean;   // 是否已翻
  readingDone: boolean; // 解读是否完成（完成后可折叠 + 出现"翻下一张"）
}

export interface FlowEntry {
  id: string;
  kind: FlowEntryKind;
  /** teller/user 的文本 */
  text?: string;
  /** ask 面板内容 */
  ask?: {
    question: string;
    options?: string[];
    kind?: string;
    cardSelection?: boolean;
    crossroads?: boolean;
  };
  /** card 条目的数据 */
  card?: FlowCardData;
  /** scroll 条目的标题 */
  title?: string;
  /** 条目完成态（ask 已回答 / card 已完成） */
  settled?: boolean;
  /** 折叠态（card 完成后默认折叠） */
  collapsed?: boolean;
}

/* ---------------- 单条渲染 ---------------- */

/** 占卜师气泡（左）— memo：delta 只重渲染正在增长的最后一个气泡 */
const TellerBubble = memo(function TellerBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div
        className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-tl-sm bg-purple-950/40 border border-purple-500/25 text-purple-50/95 text-sm md:text-base leading-relaxed whitespace-pre-wrap"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        {text}
      </div>
    </div>
  );
});

/** 用户气泡（右，靛蓝）— memo */
const UserBubble = memo(function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-[80%] px-4 py-2.5 rounded-2xl rounded-tr-sm bg-indigo-900/40 border border-indigo-400/30 text-indigo-100/90 text-sm md:text-base"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        <span className="text-indigo-300/50 text-[10px] mr-1.5 align-middle">我</span>
        {text}
      </div>
    </div>
  );
});

/** 一张牌的段落（翻牌时展开，完成后折叠成摘要行；摘要可点开/收起）— memo：
 * delta 流式期间只有"正在解读的那张牌"条目变化，其余 20+ 条目全部跳过重渲染。
 * ⚠️ 回调 props 必须引用稳定（容器传 useCallback），否则 memo 失效 */
const CardBlock = memo(function CardBlock({
  entry,
  onAnswer,
  onToggle,
  onNext,
  isLastCard,
}: {
  entry: FlowEntry;
  /** 回答该牌的确认问题（entryId 由本组件内部携带） */
  onAnswer: (entryId: string, text: string) => void;
  /** 展开/收起（引用稳定） */
  onToggle: (entryId: string) => void;
  onNext: () => void;
  isLastCard: boolean;
}) {
  const c = entry.card!;
  const [custom, setCustom] = useState("");
  /* 完成 + 折叠 → 摘要行；其余情况展开 */

  /* ---- 完成态：折叠摘要行 ---- */
  if (c.readingDone && entry.collapsed) {
    return (
      <button
        onClick={() => onToggle(entry.id)}
        className="w-full text-left px-4 py-2.5 rounded-xl border border-amber-400/25 bg-amber-950/10 hover:bg-amber-900/20 transition-all flex items-center gap-3"
      >
        <span className="text-amber-300/80 text-xs font-mono shrink-0">{c.pos}</span>
        <span className="text-amber-100/85 text-sm truncate" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
          {c.nameZh}{c.reversed ? "·逆" : ""}
        </span>
        {c.answer && (
          <span className="text-purple-300/50 text-xs truncate hidden sm:inline">我：{c.answer}</span>
        )}
        <span className="ml-auto text-amber-300/40 text-[10px] shrink-0">展开 ▾</span>
      </button>
    );
  }

  /* ---- 展开态：完整的牌段落 ---- */
  return (
    <div className="w-full rounded-2xl border border-purple-500/25 bg-[#0d0819]/70 backdrop-blur-sm overflow-hidden">
      {/* 牌头：翻牌动画（牌背 → 翻转 → 牌面，保留"亲手翻开"的仪式感）+ 名 + 位置 */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-purple-500/15">
        <motion.div
          initial={{ rotateY: 180 }}
          animate={{ rotateY: 0 }}
          transition={{ duration: 0.9, ease: [0.4, 0.1, 0.2, 1] }}
          className="relative w-12 h-[72px] shrink-0 [perspective:300px]"
        >
          {/* 牌面（翻到正面后显示） */}
          <div className="absolute inset-0 rounded-lg overflow-hidden border border-purple-400/40 [backface-visibility:hidden]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={c.image} alt={c.nameZh} className={`w-full h-full object-cover ${c.reversed ? "rotate-180" : ""}`} />
          </div>
          {/* 牌背（初始可见，随翻转消失） */}
          <div className="absolute inset-0 rounded-lg bg-[#160b26] border border-purple-500/30 flex items-center justify-center [backface-visibility:hidden] [transform:rotateY(180deg)]">
            <span className="text-purple-300/60 text-sm">✦</span>
          </div>
        </motion.div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-amber-200/95 text-base" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
              {c.nameZh}
            </span>
            {c.reversed && <span className="text-[10px] text-purple-300/60">逆位</span>}
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full border border-purple-400/40 text-purple-300/80 tracking-wider">
            {c.pos}
          </span>
        </div>
        {c.readingDone && (
          <button
            onClick={() => onToggle(entry.id)}
            className="ml-auto text-amber-300/50 text-[10px] shrink-0 hover:text-amber-200/80 transition-colors"
          >
            收起 ▴
          </button>
        )}
      </div>

      {/* 念牌：画面 + 牌意 */}
      {(c.narrative || c.meaning) && (
        <div className="px-4 py-2.5 space-y-1.5">
          {c.narrative && (
            <p className="text-sm text-purple-100/85 leading-relaxed" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
              {c.narrative}
            </p>
          )}
          {c.meaning && (
            <p className="text-xs text-sky-200/60 leading-relaxed border-l-2 border-sky-400/30 pl-2.5">
              {c.meaning}
            </p>
          )}
        </div>
      )}

      {/* 确认问答 */}
      {c.question && (
        <div className="px-4 pb-3">
          {c.answer ? (
            <div className="flex justify-end">
              <div className="max-w-[80%] px-3.5 py-2 rounded-xl rounded-tr-sm bg-indigo-900/40 border border-indigo-400/30 text-indigo-100/90 text-sm">
                {c.answer}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-purple-400/20 bg-purple-950/30 p-3">
              <p className="text-sm text-purple-50/95 mb-2" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
                {c.question}
              </p>
              <div className="flex flex-col gap-1.5 mb-2">
                {(c.options ?? ["是这样", "其实不太像", "我说不上来"]).map((o) => (
                  <button
                    key={o}
                    onClick={() => onAnswer(entry.id, o)}
                    className="text-left px-3.5 py-2 rounded-lg border border-purple-500/25 bg-purple-900/20 text-purple-100/90 hover:bg-purple-800/30 hover:border-purple-400/50 transition-all text-sm"
                    style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                  >
                    {o}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && custom.trim() && onAnswer(entry.id, custom.trim())}
                  placeholder="或说点别的…"
                  maxLength={100}
                  className="flex-1 px-3 py-2 rounded-lg bg-purple-950/40 border border-purple-500/20 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-purple-400/50 text-sm"
                />
                <button
                  onClick={() => custom.trim() && onAnswer(entry.id, custom.trim())}
                  disabled={!custom.trim()}
                  className="px-3.5 py-2 rounded-lg bg-purple-700/70 text-white text-sm disabled:opacity-40 hover:bg-purple-600/70 transition-all"
                >
                  说
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 解读（流式增长） */}
      {c.reading && (
        <div className="px-4 py-2.5 border-t border-purple-500/10">
          <p className="text-sm md:text-base text-purple-50/92 leading-relaxed whitespace-pre-wrap" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
            {c.reading}
            {!c.readingDone && <span className="typing-cursor text-purple-300">▍</span>}
          </p>
        </div>
      )}

      {/* 完成后：翻下一张 / 摘要折叠提示 */}
      {c.readingDone && (
        <div className="px-4 py-2.5 border-t border-purple-500/10 flex items-center justify-between">
          <button
            onClick={() => onToggle(entry.id)}
            className="text-[10px] text-purple-400/40 hover:text-purple-300/70 transition-colors"
          >
            {entry.collapsed ? "展开全部 ▾" : "收起 ▴"}
          </button>
          {onNext && !isLastCard && (
            <button
              onClick={onNext}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm font-medium hover:shadow-[0_0_20px_rgba(139,92,246,0.4)] transition-all"
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              翻下一张 →
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/* ---------------- 对话流容器 ---------------- */

export default function DialogueFlow({
  entries,
  onAskAnswer,
  onCardAnswer,
  onNextCard,
  onToggleEntry,
  streaming,
}: {
  entries: FlowEntry[];
  /** 回答 ask 条目（问题面板） */
  onAskAnswer: (entryId: string, answer: string) => void;
  /** 回答 card 条目上的确认问题（牌面确认，答案挂到牌上） */
  onCardAnswer: (entryId: string, answer: string) => void;
  /** 翻下一张牌（由"翻下一张"按钮触发） */
  onNextCard: () => void;
  /** 展开/收起条目 */
  onToggleEntry: (entryId: string) => void;
  /** 是否有流式输出进行中（影响自动滚动） */
  streaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户是否手动上滚（暂停流式跟随） */
  const userScrolled = useRef(false);
  /** 到底部距离阈值 */
  const STICK = 80;
  /** 已滚动锚定的 ask 条目 id（同一问题只滚一次，delta 期间不再拽动视图） */
  const anchoredAskRef = useRef<string | null>(null);
  /** 上一次的条目数（区分"新问题出现"与"流式增长"） */
  const prevCountRef = useRef(0);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK;
    userScrolled.current = !atBottom;
  };

  /** 滚动到指定条目（居中展示，不打断阅读） */
  const scrollToEntry = (entryId: string) => {
    const el = scrollRef.current;
    const node = el?.querySelector(`[data-entry-id="${entryId}"]`);
    if (el && node instanceof HTMLElement) {
      el.scrollTo({ top: node.offsetTop - el.clientHeight / 2 + node.clientHeight / 2, behavior: "smooth" });
    }
  };

  // 滚动策略（三层）：
  // ① 新的待答问题出现（ask 条目 / card 上的确认问题）→ 无论用户是否上滚，
  //    滚到该问题（只滚一次；delta 期间不再拽动视图）
  // ② 流式 delta 增长 → 仅当用户在底部时跟随（不拽动阅读位置）
  // ③ 用户上滚后不强制跟随，但新问题到来时恢复（回①）
  const pendingAsk = entries.find(
    (e) =>
      (e.kind === "ask" && !e.settled) ||
      (e.kind === "card" && e.card && !e.card.answer && e.card.question)
  );
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // ① 新待答问题：锚定滚动一次
    if (pendingAsk && anchoredAskRef.current !== pendingAsk.id) {
      anchoredAskRef.current = pendingAsk.id;
      // 等条目渲染完成
      requestAnimationFrame(() => scrollToEntry(pendingAsk.id));
      userScrolled.current = false; // 新问题 = 新上下文，恢复跟随
      prevCountRef.current = entries.length;
      return;
    }
    // ② 流式增长（条目数不变，文本变长）或新气泡：用户在底部才跟随
    if (!userScrolled.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevCountRef.current = entries.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pendingAsk 为每次渲染新算的引用，仅需响应其 id（锚定去重）
  }, [entries, streaming, pendingAsk?.id]);

  /** 最后一个 card 条目的 index（判断"翻下一张"是否该显示） */
  const lastCardIdx = (() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kind === "card") return i;
    }
    return -1;
  })();

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="w-full max-w-2xl flex-1 min-h-[300px] max-h-[62dvh] overflow-y-auto px-1 flex flex-col gap-3"
    >
      {entries.map((e, i) => {
        switch (e.kind) {
          case "teller":
            return (
              <div key={e.id} data-entry-id={e.id}>
                <TellerBubble text={e.text ?? ""} />
              </div>
            );
          case "user":
            return (
              <div key={e.id} data-entry-id={e.id}>
                <UserBubble text={e.text ?? ""} />
              </div>
            );
          case "ask":
            return (
              <div key={e.id} data-entry-id={e.id}>
                {e.settled ? (
                  <UserBubble text={e.text ?? ""} />
                ) : (
                  <AskPanel entry={e} onAnswer={(a) => onAskAnswer(e.id, a)} />
                )}
              </div>
            );
          case "card":
            return (
              <div key={e.id} data-entry-id={e.id}>
                <CardBlock
                  entry={e}
                  onAnswer={onCardAnswer}
                  onToggle={onToggleEntry}
                  onNext={onNextCard}
                  isLastCard={i === lastCardIdx}
                />
              </div>
            );
          case "scroll":
            return (
              <div key={e.id} data-entry-id={e.id}>
                <ScrollCard entry={e} onToggle={onToggleEntry} />
              </div>
            );
          default:
            return null;
        }
      })}
      {streaming && entries.length > 0 && (
        <div className="flex justify-start">
          <span className="typing-cursor text-purple-300 px-2">▍</span>
        </div>
      )}
    </div>
  );
}

/* ---------------- 问题面板（承约/呼召/澄清/岔路，插入流中的待答条目） ---------------- */

const AskPanel = memo(function AskPanel({ entry, onAnswer }: { entry: FlowEntry; onAnswer: (answer: string) => void }) {
  const [custom, setCustom] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // 三问呼召：三个输入框（必须在所有条件分支之前声明，保持 Hook 顺序）
  const [invVals, setInvVals] = useState<string[]>([]);
  const a = entry.ask!;
  const isContract = a.kind === "contract";
  const isInvocation = a.kind === "invocation";
  const isCrossroads = a.crossroads;
  const isClosing = a.kind === "closing";
  const isContinue = a.kind === "continue";

  /* ---- 翻下一张（continue）：轻量条，不打断阅读 ---- */
  if (isContinue) {
    return (
      <div className="w-full rounded-2xl border border-purple-500/25 bg-[#0d0819]/60 backdrop-blur-sm px-4 py-3">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-base">🕯</span>
          <span className="text-[10px] tracking-[0.25em] text-purple-300/60">稍作停顿</span>
        </div>
        <p className="text-sm text-purple-100/85 mb-2.5" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
          {a.question}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onAnswer("翻下一张 →")}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm hover:shadow-[0_0_20px_rgba(139,92,246,0.4)] transition-all"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            翻下一张 →
          </button>
          <button
            onClick={() => inputRef.current?.focus()}
            className="px-3.5 py-2 rounded-xl border border-purple-500/30 text-purple-200/80 text-sm hover:bg-purple-900/30 transition-all"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            我有点想法…
          </button>
          <input
            ref={inputRef}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && custom.trim() && onAnswer(custom.trim())}
            placeholder="想对占卜师说…"
            maxLength={150}
            className="flex-1 min-w-[140px] px-3.5 py-2 rounded-lg bg-purple-950/40 border border-purple-500/20 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-purple-400/60 text-sm"
          />
        </div>
      </div>
    );
  }

  /* ---- 选牌（cardSelection）：提示条——选牌动作在流外扇面完成 ---- */
  if (a.cardSelection) {
    return (
      <div className="w-full rounded-2xl border border-amber-500/30 bg-amber-950/10 backdrop-blur-md px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-base">🃏</span>
          <span className="text-[10px] tracking-[0.25em] text-amber-200/70">选 牌</span>
        </div>
        <p className="text-sm text-purple-100/85" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
          {a.question}
        </p>
        <p className="text-[11px] text-amber-300/50 mt-1.5">
          ↓ 请在下方牌扇中凭直觉点选
        </p>
      </div>
    );
  }

  const header =
    isContract ? "承 约" :
    isInvocation ? "呼 召" :
    isCrossroads ? "命运岔路口" :
    isClosing ? "收 束" :
    "占卜师问";

  const headerColor =
    isContract || isClosing ? "text-amber-200/85" :
    isCrossroads ? "text-amber-200/85" :
    "text-emerald-200/85";

  const invQuestions = isInvocation
    ? (a.question.split("\n").filter((q) => q.trim().length > 0))
    : [];

  return (
    <div
      className={`w-full rounded-2xl backdrop-blur-md p-4 md:p-5 border ${
        isCrossroads || isContract || isClosing
          ? "border-amber-500/30 bg-amber-950/10"
          : "border-emerald-500/30 bg-emerald-950/15"
      }`}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-base">{isCrossroads ? "🔮" : isContract ? "✦" : isInvocation ? "🔮" : isClosing ? "✧" : "💭"}</span>
        <span className={`text-xs tracking-[0.2em] ${headerColor}`}>{header}</span>
      </div>

      {/* 三问呼召：分行渲染 */}
      {isInvocation ? (
        <div className="space-y-3 mb-3">
          {invQuestions.map((q, i) => (
            <div key={i}>
              <p className="text-sm text-purple-100/90 mb-1.5 flex items-start gap-2" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
                <span className="text-[10px] mt-1 w-4 h-4 rounded-full border border-purple-400/40 text-purple-300/80 flex items-center justify-center shrink-0 font-mono">{i + 1}</span>
                {q.replace(/^\d+[.、]\s*/, "")}
              </p>
              <input
                value={invVals[i] ?? ""}
                onChange={(e) => {
                  const next = [...invVals];
                  next[i] = e.target.value;
                  setInvVals(next);
                }}
                placeholder={["你想听到的答案…", "你打算做的动作…", "你还没面对的担心…"][i] ?? "…"}
                maxLength={80}
                className="w-full ml-6 px-3.5 py-2 rounded-lg bg-purple-950/40 border border-purple-500/25 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-purple-400/60 text-sm"
              />
            </div>
          ))}
          <button
            onClick={() => {
              const filled = invVals.filter((v) => v?.trim());
              if (filled.length > 0) onAnswer(filled.join("\n"));
            }}
            disabled={!invVals.some((v) => v?.trim())}
            className="w-full px-4 py-2.5 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm font-medium disabled:opacity-35 transition-all"
          >
            {invVals.filter((v) => v?.trim()).length === 0 ? "至少回答一个问题" : "以此呼召 · 开始洗牌"}
          </button>
        </div>
      ) : (
        <>
          <p className="text-sm md:text-base text-purple-50/95 leading-relaxed mb-3 whitespace-pre-wrap" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
            {a.question}
          </p>
          {a.options && a.options.length > 0 && (
            <div className="flex flex-col gap-1.5 mb-2.5">
              {a.options.map((o) => (
                <button
                  key={o}
                  onClick={() => onAnswer(o)}
                  className={`text-left px-4 py-2.5 rounded-xl border transition-all text-sm ${
                    isCrossroads || isContract || isClosing
                      ? "border-amber-500/25 bg-amber-900/15 text-amber-100/90 hover:bg-amber-800/25 hover:border-amber-400/50"
                      : "border-emerald-500/25 bg-emerald-900/15 text-emerald-100/90 hover:bg-emerald-800/25 hover:border-emerald-400/50"
                  }`}
                  style={{ fontFamily: "'Ma Shan Zheng', serif" }}
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && custom.trim() && onAnswer(custom.trim())}
              placeholder="或自由输入…"
              maxLength={150}
              className="flex-1 px-3.5 py-2.5 rounded-lg bg-purple-950/40 border border-purple-500/20 text-purple-50 placeholder-purple-300/30 focus:outline-none focus:border-purple-400/50 text-sm"
            />
            <button
              onClick={() => custom.trim() && onAnswer(custom.trim())}
              disabled={!custom.trim()}
              className="px-4 py-2.5 rounded-lg bg-purple-700/70 text-white text-sm disabled:opacity-40 hover:bg-purple-600/70 transition-all"
            >
              说
            </button>
          </div>
        </>
      )}
    </div>
  );
});

/* ---------------- 命运之卷（最终总结卡片，可折叠） ---------------- */

const ScrollCard = memo(function ScrollCard({ entry, onToggle }: { entry: FlowEntry; onToggle: (entryId: string) => void }) {
  const [open, setOpen] = useState(true);
  const toggle = () => {
    setOpen(!open);
    onToggle(entry.id);
  };
  return (
    <div className="w-full rounded-2xl border border-purple-500/30 bg-gradient-to-b from-[#170d24]/85 to-[#0b0514]/85 backdrop-blur-md overflow-hidden">
      <button onClick={toggle} className="w-full px-4 py-3 flex items-center gap-2 text-left">
        <span className="text-base">📜</span>
        <span className="text-sm tracking-[0.2em] text-purple-200/90" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
          {entry.title ?? "命运之卷"}
        </span>
        <span className="ml-auto text-purple-400/40 text-[10px]">{open ? "收起 ▴" : "展开 ▾"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && entry.text && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="px-4 pb-4"
          >
            <p className="text-sm md:text-base text-purple-50/92 leading-relaxed whitespace-pre-wrap" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
              {entry.text}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
