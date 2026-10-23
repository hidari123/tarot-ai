#!/usr/bin/env node
/**
 * Mystic Tarot MCP Server（stdio）
 *
 * 把塔罗 Agent 的 4 个核心工具封装为 MCP（Model Context Protocol）服务，
 * Claude Desktop / Cursor / 任何 MCP 客户端可直接接入使用。
 *
 * 工具：
 *   tarot_draw_cards     抽牌（three/single）
 *   tarot_search         混合检索典籍（BM25+向量 RRF）
 *   tarot_card_meaning   查询单张牌完整牌意
 *   tarot_interpret      本地引擎快速解读（含正逆位、位置含义）
 *
 * 启动：node mcp-server/index.mjs
 * （Claude Desktop 配置见 README）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TAROT_CARDS, drawCards } = require("./tarot-cards.cjs");

const server = new Server(
  { name: "mystic-tarot", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "tarot_draw_cards",
    description: "抽取韦特塔罗牌（含随机正逆位）。spread='three' 三张时间流（过去/当下/未来），'single' 单张聚焦。",
    inputSchema: {
      type: "object",
      properties: {
        spread: { type: "string", enum: ["three", "single"], description: "牌阵类型，默认 three" },
      },
    },
  },
  {
    name: "tarot_search",
    description: "混合检索（BM25+向量 RRF 融合）塔罗典籍知识库。可按牌名或主题关键词检索牌意。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词" },
        top_k: { type: "number", description: "返回条数，默认 5" },
      },
      required: ["query"],
    },
  },
  {
    name: "tarot_card_meaning",
    description: "查询单张牌的完整牌意（牌面叙事/正位/逆位/关键词/元素）。",
    inputSchema: {
      type: "object",
      properties: {
        card_id: { type: "string", description: "牌 ID（如 Fool, Wands01, Cups10）或中文名（如 愚人）" },
      },
      required: ["card_id"],
    },
  },
  {
    name: "tarot_interpret",
    description: "本地引擎快速解读：给定问题与牌，产出结构化解读文本（引用典籍牌意）。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "用户问题" },
        card_ids: { type: "array", items: { type: "string" }, description: "牌 ID 列表（1~3 张）" },
      },
      required: ["question", "card_ids"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    if (name === "tarot_draw_cards") {
      const spread = args?.spread === "single" ? "single" : "three";
      const n = spread === "single" ? 1 : 3;
      const drawn = drawCards(n);
      const posNames = ["过去", "当下", "未来"];
      const text = drawn
        .map((d, i) => `${posNames[i] ?? `牌${i + 1}`}：${d.card.nameZh}（${d.card.nameEn}）${d.reversed ? "逆位" : "正位"}\n  元素：${d.card.element}\n  牌意：${d.reversed ? d.card.reversed : d.card.upright}\n  关键词：${d.card.keywords.join("、")}`)
        .join("\n\n");
      return { content: [{ type: "text", text }] };
    }

    if (name === "tarot_search") {
      const { ragSearch } = require("./rag-engine.cjs");
      const hits = ragSearch(String(args?.query ?? ""), Number(args?.top_k) || 5);
      const text = hits.length
        ? hits.map((h, i) => `[${i + 1}] ${h.source}（score=${h.score}）\n    ${h.snippet}`).join("\n")
        : "未检索到相关内容";
      return { content: [{ type: "text", text }] };
    }

    if (name === "tarot_card_meaning") {
      const idOrName = String(args?.card_id ?? "");
      const card =
        TAROT_CARDS.find((c) => c.id.toLowerCase() === idOrName.toLowerCase()) ??
        TAROT_CARDS.find((c) => c.nameZh === idOrName) ??
        TAROT_CARDS.find((c) => c.nameEn.toLowerCase().includes(idOrName.toLowerCase()));
      if (!card) return { content: [{ type: "text", text: `未找到牌：${idOrName}` }] };
      const text = `${card.nameZh}（${card.nameEn}）\n元素：${card.element}\n\n【牌面叙事】\n${card.description}\n\n【正位】${card.upright}\n【逆位】${card.reversed}\n【关键词】${card.keywords.join("、")}`;
      return { content: [{ type: "text", text }] };
    }

    if (name === "tarot_interpret") {
      const ids = Array.isArray(args?.card_ids) ? args.card_ids : [];
      const question = String(args?.question ?? "");
      const drawn = ids
        .map((id) => TAROT_CARDS.find((c) => c.id === id || c.nameZh === id))
        .filter(Boolean)
        .map((card) => ({ card, reversed: Math.random() < 0.35 }));
      if (drawn.length === 0) return { content: [{ type: "text", text: "未提供有效牌" }] };

      const posNames = ["过去之源", "当下之境", "未来之势"];
      const lines = [`问题：「${question}」`, ""];
      drawn.forEach((d, i) => {
        const meaning = d.reversed ? d.card.reversed : d.card.upright;
        lines.push(`◈ ${drawn.length === 1 ? "核心指引" : posNames[i]} · ${d.card.nameZh}${d.reversed ? "（逆位）" : "（正位）"}`);
        lines.push(`  ${d.card.element}之牌。典籍有云：${meaning}。`);
        lines.push("");
      });
      lines.push("◈ 综合启示");
      lines.push(`  关键词：${drawn.flatMap((d) => d.card.keywords).slice(0, 6).join("、")}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    return { content: [{ type: "text", text: `未知工具：${name}` }] };
  } catch (e) {
    return { content: [{ type: "text", text: `工具执行失败：${e instanceof Error ? e.message : String(e)}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Mystic Tarot MCP Server running on stdio");
