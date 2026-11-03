#!/usr/bin/env node
/**
 * 验证 P4-24：前端从不 abort SSE → 后端的客户端断开检测形同虚设
 *
 * ⚠️ 为什么这个问题值钱：
 *    后端有完整的断开检测（req.signal → client_disconnect → 停止烧 token），
 *    但前端 fetch **从不 abort** —— req.signal 永远不会触发。
 *    结果：用户误点「重新开始」→ 旧流继续跑完整场仪式（14 次 LLM 往返）
 *    → 白烧 ¥0.58/场的 token，而且后端还把它记成"正常完成"。
 *
 * 本脚本检查的是**代码事实**（前端有没有 abort 通道），
 * 而不是模拟网络行为 —— 因为这是静态可判定的。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== P4-24 前端 SSE 取消通道 ===\n");

/* ---- ① 前端有没有 AbortController ---- */
{
  const page = readFileSync(join(root, "src", "app", "page.tsx"), "utf8");
  const hasCtrl = /new AbortController\(\)/.test(page);
  // ⚠️ 检测**语义**而非字面量：
  //    signal 的值可能是 ctrl.signal / controller.signal / abortRef.current.signal
  //    —— 都是合法的"把取消信号传给 fetch"。
  const hasSignal = /signal:\s*[A-Za-z_$][\w.$]*\s*[},]/.test(page);
  const hasAbortCall = /\.abort\(\)/.test(page);
  check(
    hasCtrl && hasSignal && hasAbortCall
      ? "前端已有完整的 abort 通道（controller + signal + abort 调用）"
      : "前端缺少 abort 通道（后端断开检测无法触发）",
    hasCtrl && hasSignal && hasAbortCall,
    `AbortController=${hasCtrl} signal=${hasSignal} abort()=${hasAbortCall}`
  );
}

/* ---- ② 后端是否真的在等 abort ---- */
{
  const route = readFileSync(join(root, "src", "app", "api", "interpret", "route.ts"), "utf8");
  const listens = /req\.signal\.addEventListener\("abort"/.test(route);
  const marks = /client_disconnect/.test(route);
  check(
    "后端有 abort 监听并标记 client_disconnect",
    listens && marks,
    `监听=${listens} 标记=${marks}`
  );
  check(
    listens && marks && !page_has_ctrl()
      ? "→ 证实：后端逻辑存在但永远不会被触发（死代码）"
      : "→ 后端逻辑可达（前端已能触发）",
    listens && marks,
    ""
  );
}

function page_has_ctrl() {
  const page = readFileSync(join(root, "src", "app", "page.tsx"), "utf8");
  return /AbortController/.test(page);
}

/* ---- ④ restart 是否中断旧流 ---- */
{
  const page = readFileSync(join(root, "src", "app", "page.tsx"), "utf8");
  // 找 restart 函数体
  const m = page.match(/const restart = useCallback\(([\s\S]*?)\n  \}, \[/);
  const body = m ? m[1] : "";
  // ⚠️ 检测语义：restart 里调用了 abortStream()（或直接 .abort()）
  const aborts = /abortStream\(\)/.test(body) || /\.abort\(\)/.test(body);
  check(
    aborts ? "restart 会中断在途的 SSE 流" : "restart 不中断在途 SSE（旧流继续烧 token）",
    aborts,
    aborts ? "已接入 abortStream()" : "用户点「重新开始」后，旧占卜仍跑完整场"
  );
}

/* ---- ④ 成本影响估算 ---- */
{
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(join(root, "data", "tarot.db"));
  const row = db.prepare(`SELECT
      COUNT(*) n,
      ROUND(AVG(prompt_tokens + completion_tokens)) avg_tok
    FROM llm_usage WHERE ok = 1 AND agent = 'supervisor'`).get();
  // 一场占卜约 14 次调用（supervisor + 3 子 Agent）
  const perSession = db.prepare(`SELECT AVG(c) avg FROM (
    SELECT COUNT(*) c FROM llm_usage GROUP BY session_id)`).get();
  const avgTokens = perSession.avg * (row.avg_tok || 4000);
  console.log(`\n  成本影响估算：`);
  console.log(`    单场平均 ${perSession.avg.toFixed(1)} 次 LLM 调用`);
  console.log(`    单场平均 ${Math.round(avgTokens).toLocaleString()} token`);
  console.log(`    每误点一次「重新开始」浪费 ≈ ¥${(avgTokens / 1000 * 0.001 * 7.2).toFixed(2)}`);
  console.log(`    （token 单价按 ¥7.2/百万 token 估）`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
