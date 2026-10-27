/**
 * 塔罗牌知识库 —— 基于 tarot-lab 项目数据（github.com/look-fate/tarot-lab）
 * 78 张牌：22 大阿卡纳 + 56 小阿卡纳，含中文描述、正逆位牌意、牌面图片
 */

import rawCards from "@/data/tarot-lab-cards.json";

export type CardSuit = "major" | "wands" | "cups" | "swords" | "pentacles";

export interface TarotCard {
  id: string;          // 唯一标识：Fool / Wands01 / ...
  name: string;        // 完整名（英 + 中）
  nameZh: string;      // 中文名
  nameEn: string;      // 英文名
  number: number;      // 牌序
  suit: CardSuit;      // 类别
  element: string;     // 元素
  description: string; // 牌面描述（典籍叙事）
  upright: string;     // 正位牌意
  reversed: string;    // 逆位牌意
  keywords: string[];  // 关键词（从牌意中提取）
  image: string;       // 牌面图片路径 /images/cards/xxx.jpg
}

/* ---------- 解析 tarot-lab 数据 ---------- */

function classify(link: string, nameEn: string): { suit: CardSuit; number: number } {
  const minorMatch = nameEn.match(/^(Ace|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Page|Knight|Queen|King)\s+of\s+(Wands|Cups|Swords|Pentacles)/);
  if (minorMatch) {
    const numMap: Record<string, number> = {
      Ace: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7,
      Eight: 8, Nine: 9, Ten: 10, Page: 11, Knight: 12, Queen: 13, King: 14,
    };
    const suitAbbr = { Wands: "wands", Cups: "cups", Swords: "swords", Pentacles: "pentacles" }[minorMatch[2] as "Wands" | "Cups" | "Swords" | "Pentacles"];
    return { suit: suitAbbr as CardSuit, number: numMap[minorMatch[1]] };
  }
  // 大阿卡纳按 link 文件名匹配序号
  const majorOrder = [
    "Fool", "Magician", "High_Priestess", "Empress", "Emperor", "Hierophant",
    "Lovers", "Chariot", "Strength", "Hermit", "Wheel_of_Fortune", "Justice",
    "Hanged_Man", "Death", "Temperance", "Devil", "Tower", "Star", "Moon",
    "Sun", "Judgement", "World",
  ];
  const base = link.replace(/\.jpg$/i, "");
  const idx = majorOrder.indexOf(base);
  return { suit: "major", number: idx >= 0 ? idx : 99 };
}

const ELEMENT_BY_SUIT: Record<CardSuit, string> = {
  major: "灵（Spirit）",
  wands: "火（Fire）",
  cups: "水（Water）",
  swords: "风（Air）",
  pentacles: "土（Earth）",
};

/** 从牌意字符串提取关键词（取逗号分隔的前几个） */
function extractKeywords(normal: string, reversed: string): string[] {
  const all = (normal + "，" + reversed).split(/[，,、]/).map((s) => s.trim()).filter((s) => s.length >= 2 && s.length <= 8);
  return Array.from(new Set(all)).slice(0, 6);
}

/** 解析并去重（tarot-lab 的 World 有重复条目） */
const seen = new Set<string>();
export const TAROT_CARDS: TarotCard[] = (rawCards as Array<{
  name: string; description: string; normal: string; reversed: string; detail: string; link: string;
}>)
  .filter((c) => {
    if (seen.has(c.link)) return false;
    seen.add(c.link);
    return true;
  })
  .map((c) => {
    // 名称结构："The Fool 愚人" / "Ace of Wands 权杖一" —— 英文在前（可多词），中文在末尾
    const zhMatch = c.name.match(/[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z0-9]*$/);
    const nameZh = zhMatch ? zhMatch[0] : c.name;
    const nameEn = c.name.slice(0, c.name.length - nameZh.length).trim();
    const { suit, number } = classify(c.link, nameEn);
    return {
      id: c.link.replace(/\.jpg$/i, ""),
      name: c.name,
      nameZh,
      nameEn,
      number,
      suit,
      element: ELEMENT_BY_SUIT[suit],
      description: c.description,
      upright: c.normal,
      reversed: c.reversed,
      keywords: extractKeywords(c.normal, c.reversed),
      image: `/images/cards/${c.link}`,
    };
  });

/* ---------- 检索与抽牌 ---------- */

export function getCardById(id: string): TarotCard | undefined {
  return TAROT_CARDS.find((c) => c.id === id);
}

/** 随机抽 n 张不重复的牌（附带随机正逆位） */
export function drawCards(n: number): { card: TarotCard; reversed: boolean }[] {
  const pool = [...TAROT_CARDS];
  const drawn: { card: TarotCard; reversed: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const card = pool.splice(idx, 1)[0];
    drawn.push({ card, reversed: Math.random() < 0.35 }); // 35% 逆位
  }
  return drawn;
}

/** RAG：把抽到的牌组装成知识上下文（拼给大模型 system prompt） */
export function buildRAGContext(drawn: { card: TarotCard; reversed: boolean }[]): string {
  return drawn
    .map(({ card, reversed }, i) => {
      const pos = ["过去", "现在", "未来"][i] ?? `牌${i + 1}`;
      return (
        `【第${i + 1}张 · ${pos}】${card.nameZh}（${card.nameEn}）${reversed ? "逆位" : "正位"}\n` +
        `元素：${card.element}\n` +
        `牌面叙事：${card.description}\n` +
        `典籍牌意（${reversed ? "逆位" : "正位"}）：${reversed ? card.reversed : card.upright}\n` +
        `关键词：${card.keywords.join("、")}`
      );
    })
    .join("\n\n");
}
