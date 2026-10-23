# Mystic Tarot · AI 塔罗占卜 Agent

> 倾听星辰的低语，窥探命运的轨迹 —— 一个 **LLM Agent 工具调用循环 + BM25 RAG + 人机协同（HITL）+ SSE 流式** 的 AI 塔罗占卜应用。

## ✨ 特性

- **真·Agent 工具调用循环（ReAct 风格）**：LLM 自主决策调用 4 个工具（`rag_search` / `draw_cards` / `ask_user` / `write_reading`），最多 12 轮，非硬编码流水线；`reasoning_content` 思考链实时透出
- **人机协同（Human-in-the-Loop）**：占卜师会主动向你提出澄清问题（给出选项或自由输入），**整条 SSE 流挂起等待人类回答**（`Promise` 挂起 + `/api/answer` 唤醒），同一条连接不断线
- **BM25 RAG 检索增强**：78 张牌知识库 chunk 化（牌面叙事/正逆位/关键词 4 类字段 × 字段权重），Okapi BM25（k1=1.5, b=0.75）+ 中文 2-gram 切词打分排序，检索结果带分数可视化、解读文本「典籍有云」标注引用
- **多轮追问**：内存会话（30 分钟 TTL）保存 Agent 对话历史 + 牌面 + RAG 上下文，解读完成后可继续追问
- **Agent Trace 面板**：实时展示每一次工具调用（调用名/参数/结果摘要/耗时）+ LLM 思考链折叠展示——一眼看到"Agent 在跑"
- **SSE 流式输出**：手写 Server-Sent Events（`ReadableStream` + `fetch` reader），零 SDK 依赖，逐字打字机效果
- **78 张完整韦特塔罗**：真实牌面图片（来自 [tarot-lab](https://github.com/look-fate/tarot-lab)，公有领域资源）
- **炫酷交互**：Framer Motion 3D 卡牌翻转、星空背景、旋转魔法阵、**星尘发光自定义光标**（canvas 粒子拖尾 + 发光灵球，`prefers-reduced-motion`/触屏自动回退）
- **降级策略**：无 Key / 远程失败时切换剧本式本地引擎（模拟完整工具调用序列），演示永不中断

## 🏗️ 架构

```
┌─────────────── 前端 (React 19 + Tailwind 4 + Framer Motion) ───────────────┐
│  输入问题 → Agent 状态条 → HITL 问答卡片 → 3D 翻牌 → Trace 面板 →          │
│  RAG 知识面板(带分数) → 流式解读(打字机) → 多轮追问                        │
└──────────────────────────┬────────────────────────────────────────────────┘
                           │ fetch (SSE) + /api/answer (HITL 应答)
┌──────────────────────────▼────────────────────────────────────────────────┐
│  /api/draw      GET   随机抽牌（调试/快速模式）                            │
│  /api/interpret POST  Agent 工具调用循环 → SSE 事件流                      │
│                     { question } 首次 | { sessionId, followup } 追问       │
│  /api/answer    POST  HITL 应答（resolve 挂起的 ask_user Promise）        │
│                                                                            │
│  Agent 引擎 (src/lib/tarot-agent.ts)                                       │
│    while (round < 12):                                                     │
│      LLM 决策(带 tools) → 执行工具 → 结果回填对话历史 → 继续思考            │
│      ask_user 时: await Promise(由 /api/answer resolve) ← HITL 挂起        │
│      write_reading 时: 流式生成解读(SSE delta)                             │
│                                                                            │
│  RAG 引擎 (src/lib/rag-engine.ts)                                          │
│    78 牌 × 4 字段 chunk 化(~312 块) → BM25 打分 → top-k 带分数返回         │
└────────────────────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

```bash
npm install
npm run dev
# 打开 http://localhost:3000
```

### 接入真实大模型

创建 `.env.local`（任何 OpenAI 兼容接口均可）：

```bash
DEEPSEEK_API_KEY=sk-xxxxxxxx
OPENAI_BASE_URL=https://api.deepseek.com/v1   # 或其他兼容网关
OPENAI_MODEL=deepseek-chat                     # 或 glm-5.3 等
```

需要模型支持 **function calling**（OpenAI tools 格式）。远程模型不可用时自动降级本地引擎，演示永不中断。

## 📁 关键文件

| 文件 | 说明 |
|---|---|
| `src/lib/tarot-agent.ts` | Agent 引擎：工具调用循环 + 会话管理 + HITL 挂起 + 本地降级 |
| `src/lib/rag-engine.ts` | BM25 检索：chunk 化 + 打分 + 引用组装 |
| `src/lib/tarot-cards.ts` | 78 张牌知识库 + 抽牌 |
| `src/app/api/interpret/route.ts` | Agent SSE 接口（首次/追问） |
| `src/app/api/answer/route.ts` | HITL 应答接口（唤醒挂起的流） |
| `src/app/page.tsx` | 主界面（HITL 问答/翻牌/流式渲染/追问） |
| `src/components/AgentTrace.tsx` | Agent 工具调用 Trace 面板 |
| `src/components/KnowledgePanel.tsx` | RAG 检索命中可视化（分数条） |
| `src/components/StardustCursor.tsx` | 星尘发光自定义光标 |
| `src/data/tarot-lab-cards.json` | 塔罗知识库数据源 |
| `public/images/cards/` | 78 张韦特牌面图 |

## 🎨 设计细节（面试可讲）

- **Agent 而非流水线**：三阶段硬编码 → LLM 自主决策工具调用；`tool_calls` 驱动循环，`tool` role 消息回填观察结果，标准 ReAct 模式
- **HITL 挂起机制**：`ask_user` 工具让 Agent 循环 `await` 一个由独立 HTTP 端点 resolve 的 Promise——SSE 连接保持、流不中断，这是人机协同最直观的工程实现
- **SSE 手写实现**：服务端 `ReadableStream` 逐事件 enqueue，客户端 `fetch` + `getReader()` 逐 chunk 解析；事件协议 9 类（phase/reasoning/tool/rag_hits/cards/ask_user/delta/done/error）
- **BM25 而非向量检索**：零依赖纯 TS 实现；中文 2-gram 切词兼顾召回与简洁；字段权重（keywords 1.4 / 牌意 1.2 / 叙事 1.0）；分数归一化可视化
- **3D 翻转性能**：CSS `transform-style: preserve-3d` + `backface-visibility: hidden` 交给 GPU 合成层；Framer Motion 只做 Spring 入场
- **降级策略**：无 Key 时剧本式模拟完整工具调用序列（本地引擎），保证演示可用性

## 📄 License

牌面图片与牌意数据来自 [tarot-lab](https://github.com/look-fate/tarot-lab)（MIT）。
