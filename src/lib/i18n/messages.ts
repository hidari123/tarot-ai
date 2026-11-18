/**
 * i18n —— 极简文案表（2026-11-18 · MOIRA 品牌 + 中英切换）
 *
 * ⚠️⚠️ 为什么自己写而不是用 next-intl / react-i18next：
 *   · 项目是 App Router + `cacheComponents`，引入 i18n 库要配 middleware + 路由段
 *     → 会动到路由结构 → 风险大
 *   · 我们只需要**界面文案**双语，占卜内容（RAG 典籍、牌义）还是中文
 *   → 一个 Context + 两张表就够，零依赖 ✅
 *
 * ⚠️⚠️ 语言存哪：
 *   · localStorage（`moira-lang`）→ 用户选择持久化
 *   · `<html lang>` 跟着变 → 读屏软件和浏览器翻译都能识别
 *   · **不做路由级 i18n**（/en/...）→ 因为占卜内容没翻译，路由分语言会给人错觉
 *
 * ⚠️ 用法：
 *   const { t, lang, setLang } = useI18n();
 *   t("home.title")   // "MOIRA" / "MOIRA"
 *   t("types.love.zh") // "月引" / "Moonpull"
 */

/** 支持的语言 */
export type Lang = "zh" | "en";

export const LANGS: { id: Lang; label: string }[] = [
  { id: "zh", label: "中" },
  { id: "en", label: "EN" },
];

/**
 * ⚠️ 文案表（中文是 source of truth）
 * ⚠️ 英文缺失时**回落到中文**（不报错、不显示空白）
 */
const zh = {
  /* ---- 品牌 ---- */
  "brand.name": "MOIRA",
  "brand.tagline": "倾听星辰的低语 · 窥探命运的轨迹",

  /* ---- 首页 ---- */
  "home.subtitle": "倾听星辰的低语 · 窥探命运的轨迹",
  "home.featured":
    "写下你的困惑，占卜师会与你对话澄清、亲手选牌、给出结合牌义与典籍的解读",
  "home.inputPlaceholder": "在此写下你的困惑…",
  "home.start": "开始占卜",
  "home.chooseType": "你想问什么",
  "home.choosePersona": "选择一位占卜师",
  "home.choosePersonaHint": "可选 · 让 MOIRA 替你挑",
  "home.skipPersona": "让 MOIRA 替我选",
  "home.trust": "每张解读都附典籍出处 · 支持 78 张牌义",

  /* ---- 深度开关 ---- */
  "depth.label": "解读深度",
  "depth.standard": "标准解读",
  "depth.standardDesc": "一次给你三张牌的整体解读",
  "depth.full": "完整仪式",
  "depth.fullDesc": "占卜师先问你三个问题，每张牌翻开后单独为你解读",

  /* ---- 入口卡片 ---- */
  "entry.daily.title": "今日之牌",
  "entry.daily.desc": "今天与你有关的那张牌",
  "entry.fortune.title": "运势专区",
  "entry.fortune.desc": "每日 · 月 · 季 · 年运",
  "entry.oracle.title": "问神谕",
  "entry.oracle.desc": "不必抽牌，也能问",

  /* ---- 分类（8 个）---- */
  "types.love.zh": "月引",
  "types.love.en": "Love & Fate",
  "types.love.desc": "感情、暧昧与关系走向",
  "types.career.zh": "远途",
  "types.career.en": "Paths & Horizons",
  "types.career.desc": "工作、晋升与下一步",
  "types.wealth.zh": "丰盈",
  "types.wealth.en": "Wealth & Cost",
  "types.wealth.desc": "收入、支出与代价",
  "types.crossroads.zh": "歧路",
  "types.crossroads.en": "Crossroads",
  "types.crossroads.desc": "两个选项之间",
  "types.tides.zh": "潮汐",
  "types.tides.en": "Tides Within",
  "types.tides.desc": "情绪、焦虑与自我",
  "types.morning.zh": "晨星",
  "types.morning.en": "Today's Stars",
  "types.morning.desc": "一个小小的提醒",
  "types.kindred.zh": "故人",
  "types.kindred.en": "Kindred & Near",
  "types.kindred.desc": "朋友、同事与距离",
  "types.whispers.zh": "幽微",
  "types.whispers.en": "Whispers & Unknown",
  "types.whispers.desc": "说不清的预感",

  /* ---- 占卜师 ---- */
  "persona.mystic.name": "月影占卜师",
  "persona.mystic.tag": "谜语与意象",
  "persona.healer.name": "心灵疗愈师",
  "persona.healer.tag": "先接住你的情绪",
  "persona.blade.name": "直断导师",
  "persona.blade.tag": "不留情面的真相",
  "persona.seeker.name": "赛特行者",
  "persona.seeker.tag": "永恒尺度的答案",
  "persona.druid.name": "凯尔特林语者",
  "persona.druid.tag": "像林间闲聊",
} as const;

export type MessageKey = keyof typeof zh;

/**
 * ⚠️ 英文表（中文是 source of truth，英文必须覆盖全部 key）
 */
const en: Record<MessageKey, string> = {
  "brand.name": "MOIRA",
  "brand.tagline": "Listen to the stars · Trace your fate",

  "home.subtitle": "Listen to the stars · Trace your fate",
  "home.featured":
    "Write down your question — the reader will clarify it with you, let you pick the cards, and give an interpretation grounded in card meanings and the classics",
  "home.inputPlaceholder": "Write your question here…",
  "home.start": "Begin Reading",
  "home.chooseType": "What would you like to ask?",
  "home.choosePersona": "Choose a reader",
  "home.choosePersonaHint": "Optional · let MOIRA choose for you",
  "home.skipPersona": "Let MOIRA choose",
  "home.trust": "Every reading cites its sources · 78 card meanings covered",

  "depth.label": "Reading depth",
  "depth.standard": "Standard",
  "depth.standardDesc": "One interpretation covering all three cards",
  "depth.full": "Full Ritual",
  "depth.fullDesc":
    "The reader asks three questions first, then interprets each card as you turn it over",

  "entry.daily.title": "Card of the Day",
  "entry.daily.desc": "The one card that matters today",
  "entry.fortune.title": "Fortunes",
  "entry.fortune.desc": "Daily · Monthly · Seasonal · Yearly",
  "entry.oracle.title": "Ask the Oracle",
  "entry.oracle.desc": "No cards needed — just ask",

  "types.love.zh": "Love & Fate",
  "types.love.en": "Love & Fate",
  "types.love.desc": "Love, longing and where it's heading",
  "types.career.zh": "Paths & Horizons",
  "types.career.en": "Paths & Horizons",
  "types.career.desc": "Work, promotion and what comes next",
  "types.wealth.zh": "Wealth & Cost",
  "types.wealth.en": "Wealth & Cost",
  "types.wealth.desc": "Income, spending and what it costs",
  "types.crossroads.zh": "Crossroads",
  "types.crossroads.en": "Crossroads",
  "types.crossroads.desc": "Between two options",
  "types.tides.zh": "Tides Within",
  "types.tides.en": "Tides Within",
  "types.tides.desc": "Emotion, anxiety and self",
  "types.morning.zh": "Today's Stars",
  "types.morning.en": "Today's Stars",
  "types.morning.desc": "A small reminder for today",
  "types.kindred.zh": "Kindred & Near",
  "types.kindred.en": "Kindred & Near",
  "types.kindred.desc": "Friends, colleagues and distance",
  "types.whispers.zh": "Whispers & Unknown",
  "types.whispers.en": "Whispers & Unknown",
  "types.whispers.desc": "A hunch you can't name",

  "persona.mystic.name": "The Moonlit Reader",
  "persona.mystic.tag": "Riddles and imagery",
  "persona.healer.name": "The Healer",
  "persona.healer.tag": "Holds your feelings first",
  "persona.blade.name": "The Verdict",
  "persona.blade.tag": "Truth without comfort",
  "persona.seeker.name": "The Seeker",
  "persona.seeker.tag": "Answers on an eternal scale",
  "persona.druid.name": "The Woodspeaker",
  "persona.druid.tag": "As if chatting in a grove",
};

/** 全部文案（供类型检查） */
export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { zh, en };

/** 默认语言 */
export const DEFAULT_LANG: Lang = "zh";

/** localStorage key */
export const LANG_STORAGE_KEY = "moira-lang";
