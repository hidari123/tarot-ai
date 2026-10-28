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
 *   3. 节奏交给用户：每张牌解读完，用户**亲手点开**牌阵里的下一张牌（不自动连播）
 *   4. 自动滚动只作用于本容器，用户上滚时暂停
 */

/* ---------------- 类型 ---------------- */

export type FlowEntryKind =
  | "teller"          // 占卜师说的话（气泡）
  | "user"            // 用户的回答/选择（气泡）
  | "ask"             // 待回答的问题面板（答完转为 user 条目）
  | "card"            // 一张牌的完整段落（翻牌+念牌+问答+解读，可折叠）
  | "spread"          // 牌阵面板（三张牌背常驻，用户逐张亲手翻开）
  | "scroll";         // 命运之卷（最终总结/全文卡片）

/**
 * 牌阵面板里的一张牌（与 CardSpread 的 SpreadCard 同构）。
 * 顶部时间线与对话流牌阵共用同一份数据 → 翻一张两边同步。
 */
export interface FlowSpreadCard {
  index: number;
  id: string;
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
  /** 用户已亲手翻开 → 显示牌面 */
  flipped: boolean;
  /** 解读完成 → 金框 + ✓ */
  done: boolean;
  /** 当前该翻的 → 可点 + 呼吸光 */
  current: boolean;
  /** 典籍牌意（翻开后可显示） */
  meaning?: string;
}

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
  readingDone: boolean; // 解读是否完成（完成后可折叠为摘要行）
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
  /** spread 条目的数据（三张牌，常驻面板） */
  spread?: FlowSpreadCard[];
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
}: {
  entry: FlowEntry;
  /** 回答该牌的确认问题（entryId 由本组件内部携带） */
  onAnswer: (entryId: string, text: string) => void;
  /** 展开/收起（引用稳定） */
  onToggle: (entryId: string) => void;
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

      {/* 完成后：摘要折叠提示
       * ⚠️ 旧版这里有「翻下一张 →」按钮 —— 已移除：
       *    翻牌动作现在由**牌阵面板里点牌**触发（后端翻牌闸门）。
       *    两个入口重复，且按钮会让人误以为"跳过翻牌也能继续"。 */}
      {c.readingDone && (
        <div className="px-4 py-2.5 border-t border-purple-500/10 flex items-center justify-between">
          <button
            onClick={() => onToggle(entry.id)}
            className="text-[10px] text-purple-400/40 hover:text-purple-300/70 transition-colors"
          >
            {entry.collapsed ? "展开全部 ▾" : "收起 ▴"}
          </button>
        </div>
      )}
    </div>
  );
});

/* ---------------- 牌阵面板（对话流里的三张牌） ---------------- */

/**
 * 牌阵面板 —— 用户逐张亲手翻牌的主界面
 *
 * 为什么在对话流里而不是只在顶部：
 *   牌是这场占卜的**舞台**，用户与牌的互动必须发生在叙事流里
 *   （"我翻开第一张 → 听解读 → 再翻开第二张" 是一个连续的动作序列）。
 *   顶部时间线是同步的进度镜像，两处共用同一份状态。
 *
 * 点击语义（无翻转功能）：
 *   - 点"当前该翻的"牌 → onFlipCard(index) → 后端闸门放行 → 牌面下发
 *   - 点"已翻开"的牌   → onPreview(index) → 放大预览（只是看）
 */
const SpreadPanel = memo(function SpreadPanel({ cards, onFlipCard, onPreview }: {
  cards: FlowSpreadCard[];
  onFlipCard: (index: number) => void;
  onPreview: (index: number) => void;
}) {
  if (cards.length === 0) return null;
  const doneCount = cards.filter((c) => c.done).length;
  const nextCard = cards.find((c) => c.current);

  return (
    <div className="w-full rounded-2xl border border-amber-500/25 bg-gradient-to-b from-amber-950/10 to-[#0d0819]/70 backdrop-blur-sm px-4 py-3.5">
      {/* 标题 + 进度 */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">🃏</span>
        <span className="text-[10px] tracking-[0.25em] text-amber-200/70">你的命运之牌</span>
        <span className="ml-auto text-[11px] text-purple-300/40 font-mono">
          {doneCount}/{cards.length}
        </span>
      </div>

      {/* 三张牌 */}
      <div className="flex gap-3 md:gap-6 justify-center">
        {cards.map((c) => (
          <motion.div
            key={c.id + c.index}
            /* 宽度内联兜底：w-[68px]/md:w-[80px] 同样是 Tailwind 任意值类，
               dev 增量缓存不生成时牌列会挤成一条（与 aspect 塌陷是同源问题） */
            style={{ width: "clamp(56px, 16vw, 80px)" }}
            className="flex flex-col items-center"
          >
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full border mb-1.5 tracking-wider ${
                c.current
                  ? "border-purple-400/60 text-purple-200 bg-purple-900/40"
                  : c.done
                    ? "border-amber-400/40 text-amber-300/80 bg-amber-900/20"
                    : "border-purple-700/40 text-purple-400/50"
              }`}
            >
              {c.pos}
            </span>

            <motion.button
              type="button"
              onClick={() => {
                if (c.flipped) onPreview(c.index);
                else if (c.current) onFlipCard(c.index);
              }}
              whileHover={c.flipped || c.current ? { scale: 1.06, y: -3 } : undefined}
              animate={
                c.current
                  ? { scale: [1, 1.05, 1], boxShadow: ["0 0 0px rgba(168,85,247,0)", "0 0 22px rgba(168,85,247,0.6)", "0 0 0px rgba(168,85,247,0)"] }
                  : { scale: 1 }
              }
              transition={c.current ? { duration: 2.2, repeat: Infinity } : { duration: 0.2 }}
              /* ⚠️ aspect-ratio 同时用内联样式兜底：dev 增量编译缓存偶尔不生成
                 aspect-[2/3] 任意值类（实测：卡牌塌成 1px 横线）。内联样式
                 不经过 Tailwind，永不失效 —— 修复线上问题的最稳路径。 */
              style={{ aspectRatio: "2 / 3" }}
              className={`relative w-full rounded-xl overflow-hidden border transition-all ${
                c.current
                  ? "border-purple-400/70 shadow-[0_0_26px_rgba(168,85,247,0.35)] cursor-pointer"
                  : c.done
                    ? "border-amber-400/55 cursor-zoom-in hover:border-amber-300/80"
                    : c.flipped
                      ? "border-purple-500/40 cursor-zoom-in hover:border-purple-400/60"
                      : "border-purple-800/40"
              }`}
            >
              {c.flipped && c.image ? (
                <motion.div
                  initial={{ rotateY: 180, opacity: 0.5 }}
                  animate={{ rotateY: 0, opacity: 1 }}
                  transition={{ duration: 0.9, ease: [0.4, 0.1, 0.2, 1] }}
                  className="absolute inset-0 [perspective:600px]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.image}
                    alt={c.nameZh}
                    className={`w-full h-full object-cover ${c.reversed ? "rotate-180" : ""}`}
                  />
                </motion.div>
              ) : (
                <div className="absolute inset-0 bg-[#160b26] flex items-center justify-center">
                  <div className="w-8 h-8 rounded-full border-2 border-purple-400/50 flex items-center justify-center rune-breathe">
                    <span className="text-lg text-purple-300/70">✦</span>
                  </div>
                  <div className="absolute inset-1 rounded-lg border border-purple-500/25" />
                  {c.current && (
                    <span className="absolute bottom-1 inset-x-0 text-center text-[9px] text-purple-200/85 tracking-wider">
                      点我翻开
                    </span>
                  )}
                </div>
              )}
              {c.done && (
                <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-amber-400/90 flex items-center justify-center z-10">
                  <span className="text-[9px] text-purple-950 font-bold">✓</span>
                </div>
              )}
            </motion.button>

            <span
              className={`mt-1.5 text-[11px] text-center leading-tight ${
                c.done ? "text-amber-200/90" : c.flipped ? "text-purple-100/85" : "text-purple-400/30"
              }`}
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              {c.flipped ? (
                <>
                  {c.nameZh}
                  {c.reversed && <span className="text-[9px] block text-purple-300/50">逆位</span>}
                </>
              ) : (
                "？"
              )}
            </span>
          </motion.div>
        ))}
      </div>

      {/* 提示 */}
      <p className="mt-3 text-center text-[11px] text-purple-300/50 leading-relaxed">
        {nextCard
          ? "点开那张发光的牌，占卜师会为你念牌"
          : doneCount >= cards.length
            ? "三张牌都已讲透"
            : "等你亲手翻开下一张"}
      </p>
    </div>
  );
});

/* ---------------- 对话流容器 ---------------- */

export default function DialogueFlow({
  entries,
  onAskAnswer,
  onCardAnswer,
  onToggleEntry,
  onFlipCard,
  onPreviewCard,
  streaming,
}: {
  entries: FlowEntry[];
  /** 回答 ask 条目（问题面板） */
  onAskAnswer: (entryId: string, answer: string) => void;
  /** 回答 card 条目上的确认问题（牌面确认，答案挂到牌上） */
  onCardAnswer: (entryId: string, answer: string) => void;
  /** 展开/收起条目 */
  onToggleEntry: (entryId: string) => void;
  /** 用户亲手翻牌（点当前该翻的牌） */
  onFlipCard: (index: number) => void;
  /** 放大预览已翻开的牌 */
  onPreviewCard: (index: number) => void;
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

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="w-full max-w-2xl flex-1 min-h-[300px] max-h-[62dvh] overflow-y-auto px-1 flex flex-col gap-3"
    >
      {entries.map((e) => {
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
                />
              </div>
            );
          case "spread":
            return (
              <div key={e.id} data-entry-id={e.id}>
                <SpreadPanel
                  cards={e.spread ?? []}
                  onFlipCard={onFlipCard}
                  onPreview={onPreviewCard}
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
  const isFlip = a.kind === "flip";

  /* ---- 翻牌闸门（flip）：提示 + 插话框（主入口是牌阵面板上的牌）----
   * ⚠️ 这里**不再有「翻下一张」按钮**：翻牌动作由用户点击牌阵面板里的牌完成
   *    （点牌 = POST /api/answer{answer:"翻牌"} → 后端闸门放行 → 牌面下发）。
   *    本面板只承担两件事：
   *      1. 告诉用户"现在该翻哪张了"
   *      2. 提供插话入口（翻牌间隙说的话会被下一张牌的解读引用）
   */
  if (isFlip) {
    return (
      <div className="w-full rounded-2xl border border-purple-500/25 bg-[#0d0819]/60 backdrop-blur-sm px-4 py-3">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-base">🕯</span>
          <span className="text-[10px] tracking-[0.25em] text-purple-300/60">轮到你翻牌</span>
        </div>
        <p className="text-sm text-purple-100/85 mb-2.5" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
          {a.question}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-purple-300/50">↓ 点上方发光的牌</span>
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
