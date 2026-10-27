/**
 * 智能体记忆体系（方向①）—— 跨会话用户画像 → 承约阶段注入
 *
 * 设计：
 *   - 画像数据在 SQLite user_profiles 表（db.ts 管理）
 *   - 本模块负责把结构化画像转成"占卜师口吻"的注入文本
 *   - 注入位置：establish_contract 的 system 提示（占卜师"认识你"）
 *
 * 面试讲法：三层记忆——会话内完整上下文（session.messages）、
 * 用户级结构化画像（本模块，带 90 天衰减）、领域知识（RAG 库）。
 * 记忆管理的难点不是存，而是取得准、忘得及时。
 */

import { getUserProfile, updateUserProfile, type UserProfile } from "./db";

/** 问题主题分类（与本地降级引擎的 domainHint 保持一致的口径） */
export function classifyTopic(question: string): string {
  if (/爱|恋|婚|感情|复合|桃花|他|她|喜欢|暧昧|分手|单身/.test(question)) return "情感";
  if (/工作|事业|职场|跳槽|升职|求职|面试|offer|离职|同事|老板/.test(question)) return "事业";
  if (/钱|财|投资|理财|股|债|生意|项目/.test(question)) return "财富";
  if (/学|考试|考研|留学|毕设|成绩/.test(question)) return "学业";
  return "综合";
}

/**
 * 画像 → 占卜师注入文本（≤120 字，token 友好）。
 * 无历史返回空串（第一次占卜不注入，避免无信息噪声）。
 */
export function buildMemoryContext(userKey: string): string {
  if (!userKey) return "";
  const p = getUserProfile(userKey);
  if (p.sessionCount < 1 || (p.topics.length === 0 && !p.lastQuestion)) return "";

  const parts: string[] = [];
  // 主题画像：频次排序，最多 3 个
  const topTopics = [...p.topics].sort((a, b) => b.count - a.count).slice(0, 3);
  if (topTopics.length > 0) {
    parts.push(
      `这位访客此前来过 ${p.sessionCount} 次，主要关注：` +
      topTopics.map((t) => `${t.topic}（${t.count} 次）`).join("、")
    );
  }
  // 情绪轨迹：高频情绪，最多 3 个
  const topEmotions = [...p.emotions].sort((a, b) => b.count - a.count).slice(0, 3);
  if (topEmotions.length > 0) {
    parts.push(`常带着的情绪：${topEmotions.map((e) => e.tag).join("、")}`);
  }
  // 上次问题（承约阶段可主动关联："和上次跳槽的犹豫有关吗"）
  if (p.lastQuestion) {
    parts.push(`上次问的是「${p.lastQuestion.slice(0, 30)}」`);
  }

  const memory = parts.join("；");
  if (!memory) return "";
  // 提示占卜师如何使用记忆（自然引用，不要机械复述）
  return `【访客记忆】${memory}。可在承约时自然地关联（如"这和你上次的困惑是同一件事吗"），但不要机械复述。`;
}

/** 会话收尾时落画像（topic 分类 + 情绪轨迹） */
export function persistMemory(userKey: string, question: string, emotionTags: string[]): void {
  if (!userKey) return;
  try {
    updateUserProfile(userKey, question, classifyTopic(question), emotionTags);
  } catch {
    // 画像失败不阻断会话（记忆是增强，不是依赖）
  }
}

/** 调试：读取画像原文 */
export function debugProfile(userKey: string): UserProfile {
  return getUserProfile(userKey);
}
