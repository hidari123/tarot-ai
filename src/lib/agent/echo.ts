import type { AgentSession } from "./types";
// ⚠️ LLMProvider 定义在 llm-providers（llm.ts 只是 re-export 类型的一部分，不导出它）
import type { LLMProvider } from "../llm-providers";
import { callLLM } from "./llm";

/**
 * 收束回响（echo）—— 收束问答之后，占卜师说的**最后一段话**
 *
 * ⚠️⚠️ 为什么需要它（用户实测报告："综合与收束那里，我每次回答完问题，
 *   都是停在那里了…不要让用户停在那里"）：
 *   原来的流程：close_reading 问收束问题 → 用户答 → 直接 done。
 *   → 后端流程是**完整**的（数据实测：ask_user×10 → done×1），
 *     但用户视角是"我说完了，然后界面静止了，不知道接下来干嘛"。
 *   → 回响的作用：**给这一场一个落点**，并把用户接回对话。
 *
 * ⚠️ 设计要点：
 *   ① **不进入 supervisor 循环** —— 一次独立的 callLLM。
 *      理由：走循环会多出 1~2 轮往返（贵 + 慢 + 可能触发守卫）。
 *      这里要的是"一段得体的收尾话"，不需要工具、不需要思考。
 *   ② **语气按情绪自适应**（用户明确要求"按情绪自适应"）：
 *      复用已有的 `session.emotionTags`（承约/呼召/确认环节累积），
 *      映射到不同的**风格指令**。
 *      → 焦虑 → 先接住情绪，不急着给方案
 *      → 失落 → 承接，不说教
 *      → 愤怒不甘 → 认可这股劲，但点出代价
 *      → 平静笃定 → 确认 + 推一把
 *      → 中性 → 总结 + 一个具体行动
 *   ③ **失败可降级**：LLM 挂了/超时 → 返回 null → 前端不显示回响，
 *      **绝不影响主流程**（收束照常完成）。
 *   ④ **以一个开放问题结尾** → 用户能直接接话（走追问链路）。
 *
 * ⚠️ 为什么不用"模板拼接"：
 *   模板化会让占卜师显得像机器（用户要的是"人味"）。
 *   一次 LLM 调用换来的语气差异，是这个产品的核心价值。
 */

/* ══════════════════════════════════════════════════════════════
 * 情绪 → 风格指令
 * ══════════════════════════════════════════════════════════════ */

/** 情绪标签 → 回响的风格档案 */
interface EchoTone {
  /** 风格代号（进提示词） */
  tone: string;
  /** 给模型的具体指令 */
  instruction: string;
  /** 展示给用户的一句话前缀（前端用） */
  label: string;
}

/**
 * ⚠️ 情绪标签来自 `EMOTION_LEXICON`（helpers.ts）：
 *   紧张不安 / 迷茫 / 期待希望 / 失落受挫 / 渴望改变 / 兴奋跃跃
 * ⚠️ 优先级顺序很重要 —— 组合情绪时**先接住最需要被接住的那个**：
 *   失落 > 紧张 > 迷茫 > 愤怒不甘 > 平静笃定 > 中性
 */
function resolveTone(session: AgentSession): EchoTone {
  const tags = session.emotionTags ?? [];

  const has = (...names: string[]) => names.some((t) => tags.includes(t));

  // ① 失落受挫：最需要被承接，不要急着给方案
  if (has("失落受挫")) {
    return {
      tone: "承接",
      instruction:
        "用户的情绪里有失落、失败或被拒绝的痕迹。这种时候**不要急着给方案或建议**——" +
        "先承认这份难受是真实的、允许它存在，再轻轻问一句：这件事里，哪一部分是你最不想承认的？",
      label: "先接住这份失落",
    };
  }

  // ② 紧张不安 / 迷茫：焦虑需要被降压
  if (has("紧张不安", "迷茫")) {
    return {
      tone: "安抚",
      instruction:
        "用户带着紧张或迷茫来的。此时**不要分析牌面、不要列建议清单**——" +
        "先把悬着的那口气接住，让对方觉得'有人听懂了'，" +
        "然后给**一个极小的、今天就能做的抓手**（比如今晚只做一件事），最后问他：你最怕的其实是哪一种结果？",
      label: "先陪你把气放下",
    };
  }

  // ③ 渴望改变（伴随不甘）：认可这股劲，但点出代价
  if (has("渴望改变")) {
    return {
      tone: "认可与提醒",
      instruction:
        "用户想改变现状、可能正带着一股不甘。这股劲是**对的**，先承认它。" +
        "但要点出一个代价（离开的代价、冲动的代价），让他自己看见，而不是你替他决定。" +
        "最后问他：如果真要动，你最怕失去的是什么？",
      label: "这股劲是对的",
    };
  }

  // ④ 期待希望 / 兴奋跃跃：推一把，别让他继续观望
  if (has("期待希望", "兴奋跃跃")) {
    return {
      tone: "推一把",
      instruction:
        "用户是有期待、有冲劲的。这种时候**温柔是多余的**——" +
        "确认他心里其实已经有答案了，直说：别再等了。" +
        "然后指出一个他可能还没注意到的时机或代价，最后问他：你还在犹豫的那一点，是真的吗？",
      label: "别再等了",
    };
  }

  // ⑤ 平静/无明显情绪：总结 + 一个具体行动
  return {
    tone: "收拢",
    instruction:
      "用户的情绪比较平稳。此时把三张牌**收成一句话**（不要重复已说过的牌意），" +
      "给一个**具体到可执行**的小动作（不是方向，是动作），" +
      "最后问他：这句话里，哪一句你想再多听一遍？",
    label: "三张牌，一句话",
  };
}

/* ══════════════════════════════════════════════════════════════
 * 提示词
 * ══════════════════════════════════════════════════════════════ */

/**
 * 把三张牌的解读要点拼成素材
 *
 * ⚠️ 只取每张牌的**前 60 字** —— 完整解读正文已经在对话流里了，
 *   回响不该重复（重复 = 用户觉得"车轱辘话"）。
 */
function collectMaterials(session: AgentSession): string {
  const lines: string[] = [];

  for (const r of session.cardReadings ?? []) {
    const pos = r.pos ? `${r.pos}｜` : "";
    const reading = (r.reading ?? "").replace(/\s+/g, " ").trim();
    if (!reading) continue;
    lines.push(`- ${pos}${r.nameZh}：${reading.slice(0, 60)}…`);
  }

  if (lines.length === 0) {
    // ⚠️ 没有逐张解读（可能是降级路径）→ 用牌名兜底
    for (const d of session.drawnCards ?? []) {
      lines.push(`- ${d.card.nameZh}`);
    }
  }

  return lines.join("\n") || "（无牌面细节）";
}

/**
 * 生成回响
 *
 * @param config 首选 LLM provider（null = 由 callLLM 自动挑）
 * @param session 当前会话
 * @param userAnswer 用户对收束问题的回答
 * @returns 回响正文；失败返回 null（**不影响主流程**）
 */
export async function generateEcho(
  config: LLMProvider | null,
  session: AgentSession,
  userAnswer: string
): Promise<string | null> {
  try {
    const tone = resolveTone(session);
    const materials = collectMaterials(session);
    const answer = (userAnswer ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

    const system = [
      "你是一位塔罗占卜师，正在为这场占卜做最后的收束。",
      "",
      `**这一次的语气是：${tone.tone}。**`,
      tone.instruction,
      "",
      "硬性要求：",
      "1. 长度 100~180 字，口语化，像在对一个人说话，不要像写报告。",
      "2. **不要重复**前面已经说过的牌面细节——用户都看过了。",
      "3. **不要**罗列条目、不要用 markdown 标题、不要分点。",
      "4. 不要预测具体事件（时间、金额、人名），不要给医疗/法律/财务建议。",
      "5. 结尾必须是**一个开放的问题**（不是选择题），让用户能接着说下去。",
      "6. 只输出正文，不要任何前缀或署名。",
    ].join("\n");

    const user = [
      "【用户最初的问题】",
      session.contractQuestion ?? session.question ?? "（未记录）",
      "",
      "【这次占卜抽到的牌与解读要点】",
      materials,
      "",
      "【用户在收束环节的回答】",
      answer || "（用户没有回答）",
      "",
      "请写出这段回响。",
    ].join("\n");

    const res = await callLLM(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      undefined,
      session.id,
      "writer"
    );

    const cleaned = (res?.message?.content ?? "").replace(/\s+/g, " ").trim();
    if (cleaned.length < 20) return null;
    return cleaned;
  } catch {
    // ⚠️ 失败可降级：回响是"锦上添花"，不该拖垮收束
    return null;
  }
}
