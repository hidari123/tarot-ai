/**
 * 塔罗多 Agent 引擎 —— 兼容入口（已拆包）
 *
 * ⚠️ 本文件现在是**薄壳**：实现已按职责拆分到 src/lib/agent/ 下：
 *
 *   types.ts        共享类型（AgentEvent / AgentSession / AskKind …）
 *   session.ts      会话生命周期（创建/获取/TTL/快照恢复）
 *   hitl.ts         HITL 等待（唯一阻塞点 · 超时哨兵）
 *   llm.ts          LLM 调用（failover + 熔断器）
 *   helpers.ts      辅助函数（情绪/分支/上下文压缩/牌槽）
 *   subagents.ts    子 Agent 管线（analyst → writer → reviewer）
 *   tools/          工具（定义 + 执行器）
 *   supervisor.ts   主循环（编排中枢）
 *   fallback.ts     无 Key 降级（剧本式本地模拟）
 *
 * 拆包原因：原文件 2590 行混合了 5 种职责（会话/HITL/LLM/工具/编排），
 * 无法单测、无法并行演进。拆分后 runAgent 主循环从 1200 行降到 ~600 行，
 * 且每个子模块可以独立写测试。
 *
 * ⚠️ 本文件保留是为了**外部调用方零改动** ——
 *    `import { runAgent } from "@/lib/tarot-agent"` 继续可用。
 *    新代码请直接 import from "@/lib/agent"。
 *
 * 架构（面试可讲）：
 *
 *   ┌────────────── Supervisor（占卜师编排者，工具调用循环）──────────────┐
 *   │  决策：何时澄清(ask_user) / 抽牌(draw_cards) / 检索(rag_search)      │
 *   │        何时交给子 Agent 管线 / 是否采纳审校意见                      │
 *   └────────────────────────────┬───────────────────────────────────────┘
 *                                │ 子 Agent 管线（fixed pipeline）
 *   ┌────────────────────────────▼───────────────────────────────────────┐
 *   │  ① 🔍 牌意分析师 (analyst)                                          │
 *   │     逐牌产出结构化分析笔记（元素/牌意引用/位置含义/与问题的关联）      │
 *   │  ② ✍️ 撰写者 (writer)                                               │
 *   │     基于分析笔记 + 用户上下文撰写解读（流式输出给用户）               │
 *   │  ③ 🧐 审校者 (reviewer) — Reflexion                                 │
 *   │     三维度打分（典籍忠实 grounding / 共情 empathy / 语气 tone, 0~10）│
 *   │     任一维度 < 7 → 生成修改指令打回撰写者重写（最多 1 次）            │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * HITL：ask_user / offer_card_selection / fate_crossroads 仍是 supervisor 工具，
 *       SSE 流挂起等待 /api/answer 唤醒。
 *
 * 会话：内存 Map（globalThis 单例）+ SQLite 持久化（历史/dashboard）。
 */

export * from "./agent";
