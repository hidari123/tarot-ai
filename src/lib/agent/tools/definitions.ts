/**
 * Supervisor 工具定义 —— LLM function calling 的 schema
 *
 * 拆包自原 tarot-agent.ts（2026-10 重构）。
 *
 * ⚠️ 工具描述是**提示词的一部分**，不是文档：
 *   这里的每一句约束（"必须带引文"、"必须严格按顺序"）都在实际修复过
 *   模型行为漂移的问题 —— 删掉任何一条都可能让占卜流程退化。
 */

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "rag_search",
      description:
        "混合检索塔罗典籍知识库（BM25+向量 RRF 融合，78 张韦特牌）。当需要了解某张牌的详细牌意、或按主题查找相关牌时调用。\n" +
        "【重要】一次查询可包含多张牌名，用空格分隔即可批量检索，例如 query=\"权杖七 宝剑八 圣杯三\"。\n" +
        "请尽量合并查询（同一轮内把所有需要的牌放进一次调用），不要为每张牌单独调用一次 —— 这会成倍增加耗时与 token。\n" +
        "返回带相关度分数与命中通道的知识片段。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词，可含多个牌名或主题关键词，用空格分隔（如\"权杖七 宝剑八\"）" },
          top_k: { type: "number", description: "返回条数，默认 5；合并查询多张牌时建议 8~10" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draw_cards",
      description:
        "抽取塔罗牌。spread 决定牌阵：'three' 三张时间流（过去/当下/未来），'single' 单张聚焦。AI 可依据问题性质自行选择。注意：若想请用户亲手选牌（体验更佳），应改用 offer_card_selection。",
      parameters: {
        type: "object",
        properties: {
          spread: { type: "string", enum: ["three", "single"], description: "牌阵类型" },
        },
        required: ["spread"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "offer_card_selection",
      description:
        "展开扇形牌阵，请用户凭直觉亲手选出 3 张牌（记录选牌顺序与犹豫时长，注入解读上下文）。比随机抽牌更具仪式感，是推荐的默认方式。",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "可选牌数，默认 3" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "establish_contract",
      description:
        "【承约阶段 · 占卜第一步】在抽牌之前，先把你听到的问题复述成一个**更具体、可被牌回答**的问题，并请用户确认。\n" +
        "真实塔罗师在碰牌前都会做这一步：把「我的运势怎么样」收敛成「我在感情里会不会主动」。\n" +
        "同时声明本次占卜的牌阵范围（scope，如「我看过去、现在，和那条你正在犹豫的路」）。\n" +
        "【调用时机】用户刚说完问题、尚未抽牌时调用一次。若用户已澄清过，可直接给出你确认后的理解。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "你复述/收敛后的具体问题（30~60 字），用第二人称对用户说",
          },
          scope: {
            type: "string",
            description: "本次占卜的牌阵范围声明（15~40 字），如「我看过去与当下，以及你正在犹豫的那条路」",
          },
          confirm_options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
            description: "2~3 个确认选项（如「对，就是这个」「其实我想问别的」「再具体一点」）",
          },
        },
        required: ["question", "scope"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "invoke_three_questions",
      description:
        "【呼召阶段 · 洗牌时问的三件事】在翻牌之前，请用户回答三个问题，这三个回答会**直接成为解读的骨架**（分别对应三张牌各自要讲什么、以及最终的行动建议）：\n" +
        "① 你最想知道什么？（想知道的信息/结果）\n" +
        "② 你打算做什么？（已经决定或准备采取的行动）\n" +
        "③ 你需要防什么？（担心的风险/盲区）\n" +
        "【调用时机】选牌之前。问题要贴着用户刚确认的那个具体问题来问，不要放之四海而皆准。",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: { type: "string" },
            minItems: 3,
            maxItems: 3,
            description: "三个问题，每个 15~30 字，顺序固定：想知道什么 / 打算做什么 / 需要防什么",
          },
        },
        required: ["questions"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "向用户提出澄清问题，挂起占卜流程等待人类回答（人机协同）。在问题模糊时调用。每次占卜最多 2 次。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问用户的问题（简短、口语化）" },
          options: { type: "array", items: { type: "string" }, description: "预设选项（2~4 个，可不给）" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fate_crossroads",
      description:
        "命运岔路：解读中段，向用户呈现 2~3 条命运走向让其选择，后续解读（尤其未来牌）按选择分支。让用户参与塑造自己的解读，增强人机协同。\n" +
        "【必须同时提供 prompt 和 branches】branches 是给用户点击的选项列表（2~3 条，每条不超过 30 字）；" +
        "**不要把选项写进 prompt 里**——prompt 只是引子，选项必须放在 branches 数组里，否则用户看不到可选项。",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "岔路引子（20~60 字），只写情境铺垫，不要列举选项" },
          branches: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 4,
            description: "2~3 条走向描述（每条不超过 30 字），用户将从中选择一条",
          },
        },
        required: ["prompt", "branches"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reveal_card",
      description:
        "【逐张解读 · 翻牌】翻到牌阵中的**下一张**牌，先**念牌**：客观描述牌面画面 + 典籍牌意 + 向用户提一个**针对性的确认问题**。\n" +
        "这一步只讲这一张牌，不涉及其他牌。用户回答后再调用 interpret_card 讲透它。\n" +
        "【必须严格按顺序】一次只翻一张（card_index=0 → 1 → 2），不能跳步——\n" +
        "用户会亲手点开每一张牌，你必须等这一张被翻开并得到回答后，才能翻下一张。\n" +
        "【确认问题必须可回答】形式是二选一或三选一，选项要贴着用户的原话与情绪，\n" +
        "例如「你在这件事上，更像是『已经麻木了』还是『其实不甘心』？」——不要问空泛的「你觉得呢」。\n" +
        "【牌意必须带引文编号】meaning 引用典籍牌意时用 [n] 标注（对应 rag_search 返回的编号，如「新的开始、冒险 [3]」），\n" +
        "并在牌意开头写「典籍所载：…」——引文可点击溯源，没有引文标注的解读会被审校打回。",
      parameters: {
        type: "object",
        properties: {
          card_index: { type: "number", description: "第几张牌（从 0 开始）" },
          narrative: { type: "string", description: "牌面画面描述（40~70 字），客观说画面里有什么" },
          meaning: { type: "string", description: "典籍牌意（30~50 字），用【n】标注引用" },
          question: { type: "string", description: "向用户提的确认问题（20~40 字），要具体、可回答" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
            description: "确认问题的选项（2~3 个，用户可点选或自由输入）",
          },
        },
        required: ["card_index", "narrative", "meaning", "question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "interpret_card",
      description:
        "【逐张解读 · 讲透这一张】结合用户对确认问题的回答，把**这一张牌**讲透（100~150 字）：\n" +
        "牌意如何落在这个用户的处境上、用户在确认问题里的反应说明了什么。\n" +
        "只讲当前这一张牌，不要提前讲后面的牌。讲完后可以继续 reveal_card 翻下一张。\n" +
        "【必须带引文】引用典籍牌意时用「典籍所载：… [n]」标注（n 对应 rag_search 返回的编号）——\n" +
        "没有引文标注的解读会被审校打回。",
      parameters: {
        type: "object",
        properties: {
          card_index: { type: "number", description: "第几张牌（从 0 开始）" },
          reading: { type: "string", description: "这一张牌的完整解读（100~150 字）" },
        },
        required: ["card_index", "reading"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_reading",
      description:
        "【收束阶段 · 收尾追问】所有牌都解读完之后调用。\n" +
        "1) 先给一段收束语（80~120 字）：把三张牌连成一个故事，**回扣用户最初确认的那个具体问题**，并给出**唯一一条**可执行的下一步（不是十条建议）；\n" +
        "2) 同时附带一个「三段里哪一段最贴近你」的收尾追问，让用户自然进入追问环节。\n" +
        "【边界提醒】占卜只显示倾向，不是判决——用一句话点到即止。",
      parameters: {
        type: "object",
        properties: {
          closing: { type: "string", description: "收束语（80~120 字）：串起三张牌 + 回扣原问题 + 一条行动建议 + 边界提醒" },
          question: { type: "string", description: "收尾追问（15~30 字），如「这三段里，哪一段最贴近你现在的状态？」" },
          options: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            maxItems: 3,
            description: "收尾追问的选项（如「过去那段」「现在那段」「未来那段」）",
          },
        },
        required: ["closing", "question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_reading",
      description:
        "【最终综合】**只有在所有牌都用 reveal_card + interpret_card 逐张讲完之后**，才调用这个工具做最终综合：\n" +
        "它会启动分析师→撰写者→审校者管线，把三张牌串成一个故事、回扣用户最初的问题。\n" +
        "⚠️ 不要用它代替逐张解读——如果还没讲过任何一张牌，就先用 reveal_card。",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", description: "解读侧重，如\"情感剖析\"\"行动建议\"" },
        },
      },
    },
  },
];
