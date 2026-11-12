/**
 * 运势文案组装 —— 零 LLM 成本
 *
 * ⚠️⚠️ 为什么这一层**不调用 LLM**：
 *   每日之牌每天都要更新 —— 如果每次都调 LLM，一天 1000 次访问就是 1000 次调用
 *   （≈ ¥580/天）。而运势内容本身**不需要**生成能力：
 *   牌面故事（78 张 × 平均 180 字）+ 正逆位牌意 + 关键词 = 1.8 万字现成素材。
 *   → 用"**结构化拼装**"：典籍原文作主体 + 模板句式做连接。
 *
 * ⚠️ 诚实说明：拼装出来的文案不如 LLM 流畅，会带点"典籍摘抄"的生硬感。
 *   这是零成本方案的必然代价。对应的补偿：
 *   · **年运 / 流年 / 四季**用一次性 LLM 生成后缓存全年（见 fortune-cache.ts）
 *     —— 高价值内容值得付费，且一年只花几次钱
 *   · 每日 / 月运用拼装 —— 量太大，必须零成本
 *
 * ⚠️ 为什么模板要"多样化"：
 *   如果每天都是同一句式，读三天就腻了。
 *   → 每个层级准备多套句式，按日期哈希轮换。
 */

import type { TarotCard } from "../tarot-cards";
import { hashString } from "./deterministic";

/** 一张牌在运势里的"解读片段" */
export interface FortuneSegment {
  /** 牌名（中文） */
  nameZh: string;
  /**
   * 牌面图路径（2026-11-05 视觉重设计）
   * ⚠️ 为什么加这个字段：
   *   运势页要显示**牌面**（不是牌背）—— 没有图就没法渲染牌。
   *   之前页面只能显示牌名与文字，因为数据层没带图。
   */
  image?: string;
  /** 是否逆位 */
  reversed: boolean;
  /** 牌位（每日无牌位；年运有"年度主题"等） */
  pos?: string;
  /** 该牌的关键词（1~3 个） */
  keywords: string[];
  /** 正位或逆位的牌意（典籍原文） */
  meaning: string;
  /** 牌面故事（节选，年度/季度用） */
  narrative?: string;
  /** 拼装出的解读正文 */
  text: string;
}

/**
 * 从牌里取关键词（取前 N 个）
 */
function pickKeywords(card: TarotCard, n = 3): string[] {
  const kws = (card.keywords ?? []).filter((k) => k && k.trim().length > 0);
  return kws.slice(0, n);
}

/**
 * 每日之牌的文案（零成本）
 *
 * ⚠️ 结构：一句导语 + 牌意 + 一句行动提示。
 *   导语与提示各有多套模板，按日期哈希轮换 → 每天读起来不完全一样。
 */
export function composeDaily(card: TarotCard, reversed: boolean, dateKey: string): FortuneSegment {
  const kw = pickKeywords(card, 3);
  const meaning = (reversed ? card.reversed : card.upright).trim();
  const narrative = (card.description ?? "").trim();

  const openings = [
    `今天，${card.nameZh}在你桌面上。`,
    `${card.nameZh}——今天与你有关的那张牌。`,
    `这一天，${card.nameZh}想要对你说什么。`,
    `${card.nameZh}，今日的指引。`,
  ];
  const closings = [
    kw.length ? `留意「${kw[0]}」这个信号——它会出现在你没留意的地方。` : `今天不必急着下判断，先看清自己的情绪。`,
    kw.length ? `如果今天有人提到「${kw[0]}」，那多半不是巧合。` : `今天适合慢一点，让直觉先说话。`,
    kw.length ? `试着把「${kw[0]}」放在手边，作为今天的锚点。` : `今天能做的一件事：给自己留一点空白。`,
    kw.length ? `今天的主题是「${kw[0]}」——它值得你专门花十分钟想清楚。` : `今天不用解决全部问题，先认出最重要的那一件。`,
  ];
  const h = hashString(dateKey);
  const opening = openings[h % openings.length];
  const closing = closings[(h >> 3) % closings.length];

  return {
    nameZh: card.nameZh,
    image: card.image,
    reversed,
    keywords: kw,
    meaning,
    narrative: narrative.slice(0, 120),
    text: `${opening}\n\n${meaning}\n\n${closing}`,
  };
}

/**
 * 一周之牌的文案（零成本）
 *
 * ⚠️ 每天一句短提示，不展开 —— 周视图是"扫一眼"的，不是"读"的。
 */
export function composeWeek(
  items: Array<{ card: TarotCard; reversed: boolean; dayOffset: number }>,
  weekLabel: string
): Array<FortuneSegment> {
  const h = hashString(weekLabel);
  const templates = [
    (c: TarotCard, r: boolean, kw: string[]) =>
      `${c.nameZh}${r ? "逆位" : ""}：${kw[0] ?? "留意直觉"}。${r ? "别急着下判断" : "可以往前一步"}。`,
    (c: TarotCard, r: boolean, kw: string[]) =>
      r
        ? `${c.nameZh}提醒你：${kw[0] ?? "有些事"}需要缓一缓，别硬推。`
        : `${c.nameZh}给了你一个开口：${kw[0] ?? "试试新的做法"}。`,
    (c: TarotCard, r: boolean, kw: string[]) =>
      `${c.nameZh}${r ? "（逆）" : ""} · ${kw.slice(0, 2).join("、") || "保持观察"}。`,
  ];
  return items.map((it, i) => {
    const kw = pickKeywords(it.card, 2);
    const tpl = templates[(h + i) % templates.length];
    return {
      nameZh: it.card.nameZh,
    image: it.card.image,
      reversed: it.reversed,
      keywords: kw,
      meaning: (it.reversed ? it.card.reversed : it.card.upright).trim(),
      text: tpl(it.card, it.reversed, kw),
    };
  });
}

/**
 * 月运三张的文案（零成本）
 */
export function composeMonthly(
  items: Array<{ card: TarotCard; reversed: boolean; period: string }>,
  monthLabel: string
): Array<FortuneSegment> {
  const h = hashString(monthLabel);
  const leads = [
    (p: string) => `${p}：这一段的重点是`,
    (p: string) => `${p}，牌面给的是`,
    (p: string) => `${p}的能量落在`,
  ];
  return items.map((it, i) => {
    const kw = pickKeywords(it.card, 2);
    const meaning = (it.reversed ? it.card.reversed : it.card.upright).trim();
    const lead = leads[(h + i) % leads.length](it.period);
    const tail = it.reversed
      ? "别把这次的迟滞当成失败——它在提醒你换个方向。"
      : "顺流的时候要留意，别把好运气用完了。";
    return {
      nameZh: it.card.nameZh,
    image: it.card.image,
      reversed: it.reversed,
      pos: it.period,
      keywords: kw,
      meaning,
      text: `${lead}「${kw[0] ?? it.card.nameZh}」。${meaning}\n\n${tail}`,
    };
  });
}

/**
 * 四季牌阵的文案（零成本拼装版本）
 *
 * ⚠️ 四季是"高价值内容" —— 优先走 LLM 一次性生成（fortune-cache.ts）。
 *   这里的拼装版本是**降级路径**（LLM 不可用时的兜底），保证功能不挂。
 */
export function composeSeason(
  items: Array<{ card: TarotCard; reversed: boolean; pos: string }>,
  seasonLabel: string
): Array<FortuneSegment> {
  const h = hashString(seasonLabel);
  const posLeads = [
    (p: string) => `【${p}】`,
    (p: string) => `${p} ——`,
    (p: string) => `**${p}**`,
  ];
  return items.map((it, i) => {
    const kw = pickKeywords(it.card, 3);
    const meaning = (it.reversed ? it.card.reversed : it.card.upright).trim();
    const narrative = (it.card.description ?? "").trim().slice(0, 160);
    const lead = posLeads[(h + i) % posLeads.length](it.pos);
    return {
      nameZh: it.card.nameZh,
    image: it.card.image,
      reversed: it.reversed,
      pos: it.pos,
      keywords: kw,
      meaning,
      narrative,
      text: `${lead}${it.card.nameZh}${it.reversed ? "（逆位）" : ""} · ${kw.join("、")}\n\n${narrative}\n\n${meaning}`,
    };
  });
}

/**
 * 年运 / 流年的拼装版本（降级路径）
 *
 * ⚠️ 正常路径是 LLM 一次性生成后缓存全年（fortune-cache.ts）。
 *   这里只作为"LLM 不可用"时的兜底。
 */
export function composeYear(
  theme: { card: TarotCard; reversed: boolean },
  months: Array<{ card: TarotCard; reversed: boolean; month: number }>,
  year: number
): { theme: FortuneSegment; months: FortuneSegment[] } {
  const kw = pickKeywords(theme.card, 3);
  const themeMeaning = (theme.reversed ? theme.card.reversed : theme.card.upright).trim();
  const narrative = (theme.card.description ?? "").trim().slice(0, 200);

  return {
    theme: {
      nameZh: theme.card.nameZh,
    image: theme.card.image,
      reversed: theme.reversed,
      keywords: kw,
      meaning: themeMeaning,
      narrative,
      text:
        `${year} 年的主题牌是「${theme.card.nameZh}」${theme.reversed ? "（逆位）" : ""}。\n\n` +
        `${narrative}\n\n` +
        `${themeMeaning}\n\n` +
        `这一年你要学的，是${kw[0] ?? "如何与自己的节奏相处"}。`,
    },
    months: months.map((m) => {
      const mkw = pickKeywords(m.card, 2);
      const mm = (m.reversed ? m.card.reversed : m.card.upright).trim();
      return {
        nameZh: m.card.nameZh,
    image: m.card.image,
        reversed: m.reversed,
        pos: `${m.month} 月`,
        keywords: mkw,
        meaning: mm,
        text: `${m.month} 月 · ${m.card.nameZh}${m.reversed ? "（逆位）" : ""} · ${mkw.join("、")}\n\n${mm}`,
      };
    }),
  };
}
