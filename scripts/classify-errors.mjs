#!/usr/bin/env node
/**
 * Error 会话自动归因（方向④）：LLM 聚类 error 会话，输出 top 失败原因
 *
 * 用法：node scripts/classify-errors.mjs
 * 数据源：sessions WHERE status='error'（error_reason + question + tool_calls 摘要）
 */

import Database from "better-sqlite3";

const db = new Database("data/tarot.db");

const rows = db.prepare(`
  SELECT s.id, s.question, s.error_reason, s.created_at,
         (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) toolCount,
         (SELECT GROUP_CONCAT(t.tool) FROM tool_calls t WHERE t.session_id = s.id ORDER BY t.id DESC LIMIT 5) lastTools
  FROM sessions s WHERE s.status = 'error'
  ORDER BY s.created_at DESC LIMIT 100
`).all();

if (rows.length === 0) {
  console.log("没有 error 会话可归因 ✨");
  process.exit(0);
}

// ---- 规则归因（无 LLM 依赖，本地规则覆盖常见模式） ----
const ATTRS = [];

for (const r of rows) {
  let attr;
  let detail = "";
  switch (r.error_reason) {
    case "client_disconnect":
      attr = "客户端断开";
      detail = "用户关页/刷新/网络中断（体验问题，非系统故障）";
      break;
    case "llm_error":
      attr = "LLM 调用失败";
      detail = r.toolCount <= 2 ? "极早期失败（疑似配额/网络）" : "流程中段失败（疑似上下文/参数）";
      break;
    case "max_rounds":
      attr = "轮次耗尽";
      detail = "模型决策循环未收敛（检查是否检索撞墙/流程卡死）";
      break;
    case "deadline_exceeded":
      attr = "超时中止";
      detail = "活跃处理超 8 分钟（LLM 慢或工具重试过多）";
      break;
    case "ttl_expired":
      attr = "会话过期";
      detail = "30 分钟无活动被清理（用户离开）";
      break;
    case "stale_timeout":
      attr = "僵死回收";
      detail = "进程重启/断开后未收尾，启动对账标记（见 reconcileStaleSessions）";
      break;
    case "analyst_empty":
      attr = "分析师空产出";
      detail = "analyst 未产出笔记（检查 analyst prompt 与 max_tokens）";
      break;
    case "engine_exception":
      attr = "引擎异常";
      detail = "未捕获异常（需查日志定位）";
      break;
    default:
      attr = "未知";
  }
  ATTRS.push({ id: r.id, attr, detail, question: r.question, lastTools: r.lastTools ?? "" });
}

// ---- 聚类汇总 ----
const byAttr = {};
for (const a of ATTRS) {
  byAttr[a.attr] = byAttr[a.attr] ?? { count: 0, details: {} };
  byAttr[a.attr].count++;
  byAttr[a.attr].details[a.detail] = (byAttr[a.attr].details[a.detail] ?? 0) + 1;
}

console.log(`\n📊 Error 会话归因（共 ${ATTRS.length} 场）\n`);
const sorted = Object.entries(byAttr).sort((a, b) => b[1].count - a[1].count);
for (const [attr, info] of sorted) {
  console.log(`  ${attr}: ${info.count} 场 (${Math.round((info.count / ATTRS.length) * 100)}%)`);
  for (const [d, c] of Object.entries(info.details).sort((a, b) => b[1] - a[1])) {
    console.log(`    - ${d}: ${c}`);
  }
}

// ---- 可操作建议 ----
console.log(`\n💡 建议优先处理：`);
const top = sorted[0];
if (top) {
  const [attr, info] = top;
  if (attr === "客户端断开") console.log("  客户端断开占比最高：检查前端是否有引导流失的体验问题（等待过久/交互卡点）");
  if (attr === "LLM 调用失败") console.log("  LLM 失败占比最高：检查 provider 健康状态与 failover 触发日志");
  if (attr === "轮次耗尽") console.log("  轮次耗尽占比最高：检查 rag_search 撞墙守卫是否生效、MAX_ROUNDS 是否需要上调");
  console.log(`  （${info.count} 场，占 error 的 ${Math.round((info.count / ATTRS.length) * 100)}%）`);
}
console.log("");
