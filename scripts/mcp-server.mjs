#!/usr/bin/env node
/**
 * Mystic Tarot MCP Server —— 把占卜能力包成 MCP 工具
 *
 * P3-⑨：让 Claude Desktop / Cursor / 任何 MCP 客户端都能调用塔罗占卜。
 *
 * 暴露 3 个工具：
 *   1. draw_cards        抽牌（三张时间流 / 单张聚焦）
 *   2. interpret_cards   解读（本地规则引擎，含典籍牌意）
 *   3. search_tarot      检索典籍知识库（BM25 + 向量混合）
 *
 * ⚠️ 设计取舍（面试可讲）：
 *   MCP 工具是**无状态**的 —— 不暴露整场 HITL 仪式（那是 Web 前端的事）。
 *   MCP 场景是"给 AI 助手一个可调用的塔罗知识/抽牌能力"，
 *   客户端 AI 自己编排对话节奏，我们提供原子能力。
 *   工具实现与传输层解耦（src/lib/mcp-tools.ts）—— 可独立测试。
 *
 * 启动：npx tsx scripts/mcp-server.mjs（stdio transport）
 * Claude Desktop 配置（claude_desktop_config.json）：
 *   {
 *     "mcpServers": {
 *       "mystic-tarot": {
 *         "command": "npx",
 *         "args": ["tsx", "<项目路径>/scripts/mcp-server.mjs"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DrawCardsSchema, InterpretCardsSchema, SearchTarotSchema,
  drawCards, interpretLocally, searchTarot,
  type McpDeps,
} from "../src/lib/mcp-tools";

// ---- 加载项目模块（TS 源，需 tsx 运行）----
async function loadDeps(): Promise<McpDeps> {
  try {
    const cards = await import("../src/lib/tarot-cards");
    const rag = await import("../src/lib/rag-engine");
    return { TAROT_CARDS: cards.TAROT_CARDS, hybridSearch: rag.hybridSearch };
  } catch (e) {
    console.error("[mcp] 无法加载项目模块，请用 tsx 运行：npx tsx scripts/mcp-server.mjs");
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }
}

const deps = await loadDeps();

/* ------------------------------------------------------------------ */
/* MCP Server 定义                                                     */
/* ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "mystic-tarot", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ---- 工具 1：抽牌 ----
server.tool(
  "draw_cards",
  "抽取塔罗牌。spread: 'three' 三张时间流（过去/当下/未来）或 'single' 单张聚焦。返回牌名、位置、正逆位、牌意与关键词。",
  DrawCardsSchema.shape,
  async ({ spread, seed }) => ({
    content: [{ type: "text", text: JSON.stringify({ spread, cards: drawCards(deps, spread, seed) }, null, 2) }],
  })
);

// ---- 工具 2：解读 ----
server.tool(
  "interpret_cards",
  "基于已抽的牌给出结构化解读（本地规则引擎：典籍牌意 + 关键词 + 位置含义）。MCP 客户端的 AI 应在此基础上用自己的语言组织最终解读。",
  InterpretCardsSchema.shape,
  async ({ question, cards, focus }) => {
    const drawn = cards
      .map((ref) => {
        const card = deps.TAROT_CARDS.find((c) => c.id === ref.id);
        if (!card) return null;
        return {
          id: card.id, nameZh: card.nameZh, nameEn: card.nameEn, pos: ref.pos,
          reversed: ref.reversed, image: card.image,
          meaning: ref.reversed ? card.reversed : card.upright,
          keywords: card.keywords ?? [],
        };
      })
      .filter(Boolean);
    if (drawn.length === 0) {
      return { content: [{ type: "text", text: "错误：未找到任何有效牌 id（请先用 draw_cards 抽牌）" }] };
    }
    return { content: [{ type: "text", text: interpretLocally(question, drawn, focus) }] };
  }
);

// ---- 工具 3：典籍检索 ----
server.tool(
  "search_tarot",
  "混合检索塔罗典籍知识库（BM25 字面 + 向量语义，RRF 融合，78 张韦特牌）。query 可含牌名或主题关键词；返回带相关度分数与命中通道的知识片段。",
  SearchTarotSchema.shape,
  async ({ query, top_k }) => ({
    content: [{ type: "text", text: await searchTarot(deps, query, top_k) }],
  })
);

/* ------------------------------------------------------------------ */
/* 启动（stdio transport）                                             */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mcp] mystic-tarot MCP server 已启动（stdio）· 工具: draw_cards / interpret_cards / search_tarot");
