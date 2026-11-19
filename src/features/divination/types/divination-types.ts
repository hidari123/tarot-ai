/**
 * 占卜分类 —— 8 个主题（2026-11-18 · MOIRA 首页重排）
 *
 * ⚠️⚠️ 为什么要有这个概念（信息架构的问题）：
 *   原来的首页让用户先选「**占卜师**」（月影/直断/疗愈/赛特/凯尔特）
 *   → 用户根本分不清这 5 个有什么区别 → 随便点一个 ❌
 *   · 用户的真实心智是「**我想问什么**」（爱情/工作/钱/选择/情绪/今天/朋友/预感）
 *   · 占卜师是「**谁来说**」—— 是**风格参数**，不是**准入条件**
 *   → 改成两级：先选**问什么**（第一级）→ 再选**谁来说**（第二级，可跳过）✅
 *
 * ⚠️ 命名原则（用户要求）：
 *   · 中文主名要**唯美**、不要大白话（副标题负责说清楚）
 *   · 英文要**浪漫但能理解语义**
 *   · 主名是双字/短词，副标题是白话描述
 */

export interface DivinationType {
  id: string;
  /** 中文主名（唯美） */
  zh: string;
  /** 英文名（浪漫但易懂） */
  en: string;
  /** 白话副标题（说明问什么） */
  desc: string;
  /** 图标路径（public/images/types/xxx.webp） */
  icon: string;
  /** 默认占卜师（用户不选时用谁） */
  defaultPersona: string;
}

export const DIVINATION_TYPES: DivinationType[] = [
  {
    id: "love",
    zh: "月引",
    en: "Love & Fate",
    desc: "感情、暧昧与关系走向",
    icon: "/images/types/love.webp",
    defaultPersona: "mystic",
  },
  {
    id: "career",
    zh: "远途",
    en: "Paths & Horizons",
    desc: "工作、晋升与下一步",
    icon: "/images/types/career.webp",
    defaultPersona: "blade",
  },
  {
    id: "wealth",
    zh: "丰盈",
    en: "Wealth & Cost",
    desc: "收入、支出与代价",
    icon: "/images/types/wealth.webp",
    defaultPersona: "seeker",
  },
  {
    id: "crossroads",
    zh: "歧路",
    en: "Crossroads",
    desc: "两个选项之间",
    icon: "/images/types/crossroads.webp",
    defaultPersona: "blade",
  },
  {
    id: "tides",
    zh: "潮汐",
    en: "Tides Within",
    desc: "情绪、焦虑与自我",
    icon: "/images/types/tides.webp",
    defaultPersona: "healer",
  },
  {
    id: "morning",
    zh: "晨星",
    en: "Today's Stars",
    desc: "一个小小的提醒",
    icon: "/images/types/morning.webp",
    defaultPersona: "druid",
  },
  {
    id: "kindred",
    zh: "故人",
    en: "Kindred & Near",
    desc: "朋友、同事与距离",
    icon: "/images/types/kindred.webp",
    defaultPersona: "healer",
  },
  {
    id: "whispers",
    zh: "幽微",
    en: "Whispers & Unknown",
    desc: "说不清的预感",
    icon: "/images/types/whispers.webp",
    defaultPersona: "seeker",
  },
];

/** 按 id 取分类（找不到返回 undefined） */
export function getType(id: string | null | undefined): DivinationType | undefined {
  if (!id) return undefined;
  return DIVINATION_TYPES.find((t) => t.id === id);
}
