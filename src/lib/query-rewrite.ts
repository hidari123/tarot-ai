/**
 * 查询改写（方向②）：口语化问题 → 检索友好的关键词 + 牌名候选
 *
 * 为什么需要：BM25 是字面匹配，"分手了还能复合吗"不含任何牌名，
 * 2-gram 命中的是随机字面重叠（"复合"≈"复杂"），零有效召回。
 * golden set 实测：口语查询 Recall@5 仅 44.6%，牌名直查接近 100%。
 *
 * 策略（分层，无 LLM 也工作）：
 *   1. 主题词典映射（本地、零延迟）：情感/复合/财富/事业等高频主题 → 候选牌名
 *   2. LLM 改写（可选，延迟敏感时关闭）：口语 → 3-5 个检索关键词
 * 返回：改写后的查询串（原查询 + 候选牌名合并）
 */

/** 主题 → 相关牌（中文名，与 tarot-cards 的 nameZh 对齐） */
const TOPIC_CARD_MAP: Array<{ test: RegExp; cards: string[] }> = [
  { test: /复合|前任|前男|前女|旧情|想挽回|和好/, cards: ["圣杯六", "恋人", "圣杯二"] },
  { test: /结婚|订婚|求婚|承诺|一辈子|终身/, cards: ["权杖四", "圣杯二", "恋人", "教皇"] },
  { test: /单身|脱单|有对象|桃花|什么时候.*对象|没人喜欢/, cards: ["恋人", "圣杯二", "圣杯王牌"] },
  { test: /分手|分开|结束.*关系|感情.*结束/, cards: ["宝剑十", "死神", "圣杯八"] },
  { test: /暗恋|表白|喜欢.*吗|他.*喜欢|她.*喜欢|心意/, cards: ["恋人", "圣杯二", "圣杯侍卫"] },
  { test: /异地|两地|距离|远.*恋/, cards: ["权杖二", "战车", "圣杯六"] },
  { test: /跳槽|换工作|离职|辞职|新工作/, cards: ["愚人", "战车", "权杖二", "星币八"] },
  { test: /面试|offer|录用|求职|找工作/, cards: ["权杖王牌", "星币八", "战车", "太阳"] },
  { test: /升职|晋升|加薪|涨薪|事业发展/, cards: ["战车", "太阳", "权杖六", "权杖王牌"] },
  { test: /领导|老板|上司|权威|管我/, cards: ["皇帝", "教皇", "权杖国王"] },
  { test: /同事|团队|合作|内耗|矛盾/, cards: ["权杖五", "宝剑二", "节制"] },
  { test: /投资|理财|股票|项目.*靠谱|赚钱|亏/, cards: ["星币王牌", "星币十", "星币侍卫", "星币二"] },
  { test: /钱|财运|财富|积蓄/, cards: ["星币王牌", "星币十", "星币国王"] },
  { test: /焦虑|不安|紧张|失眠|压力大|担心|怕/, cards: ["宝剑九", "月亮", "节制"] },
  { test: /迷茫|没方向|不知道.*怎么办|选择困难|纠结|犹豫/, cards: ["宝剑二", "恋人", "圣杯七"] },
  { test: /抑郁|低落|不开心|难过|伤心/, cards: ["圣杯四", "宝剑九", "月亮"] },
  { test: /放下|释怀|忘记|过去|执念|不甘心/, cards: ["圣杯八", "倒吊人", "圣杯四"] },
  { test: /坚持|放弃|要不要.*继续|熬/, cards: ["权杖九", "权杖七", "力量", "战车"] },
  { test: /骗|欺骗|隐瞒|背叛|不老实/, cards: ["宝剑七", "月亮", "恶魔"] },
  { test: /控制|操控|拿捏|PUA/, cards: ["恶魔", "皇帝"] },
  { test: /健康|身体|生病|休息/, cards: ["节制", "星星", "太阳", "圣杯九"] },
  { test: /家庭|家人|父母|亲情/, cards: ["圣杯十", "权杖四", "女皇"] },
  { test: /学业|考试|考研|留学|毕业/, cards: ["教皇", "星币八", "星星", "愚人"] },
  { test: /创意|灵感|创作|写作/, cards: ["星星", "圣杯王牌", "圣杯侍卫", "女皇"] },
  { test: /摊牌|说清楚|对质|真相/, cards: ["正义", "宝剑二", "宝剑王牌"] },
  { test: /秘密|未知|看不清|摸不透/, cards: ["月亮", "女祭司", "恶魔"] },
  // —— 数字/别名俗称（牌名封闭词表的别名扩展）——
  { test: /13\s*号牌?|十三号牌?/, cards: ["死神"] },
  { test: /(\d+)\s*号牌?/, cards: [] }, // 数字泛指：交给 LLM/占卜流程解析，不盲映射
  // —— 剩余高频口语（golden set 零命中分析补充）——
  { test: /意外|突然|打击|崩塌|突变|变故|猝不及防/, cards: ["高塔"] },
  { test: /最坏|谷底|至暗|低谷/, cards: ["宝剑十", "死神"] },
  { test: /上升期|高光|顺风|春风得意/, cards: ["战车", "太阳", "权杖六"] },
  { test: /冲动|乱花|剁手|不理性.*花|消费/, cards: ["圣杯七", "星币骑士", "星币四"] },
  { test: /瓶颈|停滞|卡住|上不去|平台期/, cards: ["圣杯八", "倒吊人", "隐士"] },
];

/** 检查查询是否已含牌名（含则无需主题补充——牌名精确通道已覆盖） */
function hasCardName(query: string, cardNames: string[]): boolean {
  return cardNames.some((n) => query.includes(n));
}

/**
 * 本地主题改写：query → query + 命中主题的候选牌名
 * （LLM 不参与：检索路径上每秒都可能调用，延迟敏感）
 */
export function rewriteQueryLocal(query: string, allCardNamesZh: string[]): string {
  if (hasCardName(query, allCardNamesZh)) return query; // 已含牌名，不改写
  const additions = new Set<string>();
  for (const { test, cards } of TOPIC_CARD_MAP) {
    if (test.test(query)) {
      for (const c of cards) additions.add(c);
    }
  }
  if (additions.size === 0) return query;
  return `${query} ${[...additions].slice(0, 4).join(" ")}`;
}

/**
 * LLM 改写（可选增强）：口语 → 检索关键词。
 * 供 rag_search 工具调用方使用；LLM 不可用时回退 rewriteQueryLocal。
 */
export async function rewriteQueryWithLLM(
  query: string,
  llmCall: (prompt: string) => Promise<string>
): Promise<string> {
  try {
    const prompt = `把这句口语化的占卜问题改写成塔罗牌检索关键词（3-6 个词，含可能的牌名，不要解释）：
"${query}"
直接输出关键词，空格分隔：`;
    const out = await llmCall(prompt);
    const keywords = out.trim().replace(/\n/g, " ").slice(0, 120);
    if (keywords.length >= 2) {
      // 保留原查询 + 改写关键词（召回面更宽）
      return `${query} ${keywords}`;
    }
  } catch {
    /* LLM 失败回退本地 */
  }
  return query;
}
