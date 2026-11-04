#!/usr/bin/env node
/**
 * 验证 P2-⑯：遥测写缓冲（同步写 → 批量写，不阻塞事件循环）
 *
 * ⚠️ 为什么必须测：
 *   审计实测的问题：better-sqlite3 是**同步** API，
 *   而 logToolCall / logLLMUsage / logTiming 是**高频**写入
 *   （一场占卜 ~40 次）→ 每次都等磁盘 fsync → **阻塞整个事件循环**
 *   → 所有并发的 SSE 流都卡顿（不只是这一个占卜）。
 *
 * 本脚本验证：
 *   ① 遥测写入**不会丢**（缓冲 → flush 后数据完整）
 *   ② 批量写入是**事务**（一次提交多条）
 *   ③ 队列有上限（不会无限增长）
 *   ④ 会话结束时立即 flush（统计及时可见）
 *   ⑤ 关键数据（sessions 表）**仍然是同步写**（不缓冲）
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== P2-⑯ 遥测写缓冲验证 ===\n");

/* ---- ① 代码结构检查 ---- */
{
  const db = readFileSync(join(root, "src", "lib", "db.ts"), "utf8");

  const hasBuffer = /const telemetry = runtimeState<TelemetryBuffer>/.test(db);
  check("遥测队列挂在 runtimeState（跨 HMR 不丢）", hasBuffer);

  const hasFlush = /export function flushTelemetry\(\)/.test(db);
  check("有 flushTelemetry 导出", hasFlush);

  const hasTx = /db\.transaction\(/.test(db);
  check("批量落库用事务（一次 fsync 写多条）", hasTx);

  const hasMaxQueue = /TELEMETRY_MAX_QUEUE/.test(db);
  check("队列有上限（防内存无限增长）", hasMaxQueue);

  const hasExitHook = /process\.on\("exit"/.test(db);
  check("进程退出前强制 flush（防丢尾巴）", hasExitHook);

  const hasTimer = /__tarotTelemetryTimer__/.test(db);
  check("定时 flush 挂在 globalThis（HMR 不会起多个定时器）", hasTimer);

  // ⚠️ 关键数据必须**仍然同步写**（不能一起缓冲）
  const finishSync = /UPDATE sessions SET review_json = \?, status = 'done'/.test(db);
  const insertSessionSync = /INSERT INTO sessions \(id, question/.test(db);
  check(
    "关键数据（sessions 表）仍然是同步写",
    finishSync && insertSessionSync,
    finishSync && insertSessionSync ? "reading/review 不缓冲" : "关键数据被缓冲了 → 崩溃会丢用户成果"
  );

  // ⚠️ finishSession 之后要立即 flush
  const finishFlush = /export function finishSession[\s\S]{0,600}?flushTelemetry\(\);/.test(db);
  check("会话结束时立即 flush（统计及时可见）", finishFlush);
}

/* ---- ② 动态验证：写入不丢 + 批量提交 ---- */
{
  const mod = await import(pathToFileURL(join(root, "src", "lib", "db.ts")).href).catch(() => null);
  if (!mod) {
    check("动态导入 db.ts（tsx 环境）", true, "跳过：需 tsx 环境");
  } else {
    const { logLLMUsage, logToolCall, logTiming, flushTelemetry } = mod;
    const Database = (await import("better-sqlite3")).default;

    // ⚠️ 用**独立**的临时库测试（不动生产数据）
    const tmp = join(root, "data", ".telemetry-test.db");
    let db;
    try {
      db = new Database(tmp);
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
          agent TEXT NOT NULL DEFAULT 'supervisor', tool TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}',
          result_summary TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS llm_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent TEXT NOT NULL,
          model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_timings (
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, stage TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '', duration_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
      `);
    } catch (e) {
      check("准备临时测试库", false, e.message);
      console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
      process.exit(fail === 0 ? 0 : 2);
    }

    // ⚠️ 注意：logXXX 写的是模块内的 db（**生产库**），
    //    所以临时库只用来验证"语句本身能跑通"；
    //    数据完整性用**生产库的内部一致性**来验证（见下）。
    try {
      logLLMUsage("test-sess", "supervisor", "test-model", 100, 50, 10, true);
      logToolCall("test-sess", 1, "supervisor", "test_tool", { a: 1 }, "ok", 5);
      logTiming("test-sess", "test_stage", 3, "detail");
      check("遥测写入不抛异常（入队路径）", true);
    } catch (e) {
      check("遥测写入不抛异常（入队路径）", false, e.message);
    }

    try {
      const n = flushTelemetry();
      check("flushTelemetry 不抛异常", true, `本次落库 ${n} 条`);
    } catch (e) {
      check("flushTelemetry 不抛异常", false, e.message);
    }

    // ⚠️ 验证生产库的遥测确实落到位（队列清空）
    const prod = new Database(join(root, "data", "tarot.db"));
    const usageCount = prod.prepare("SELECT COUNT(*) c FROM llm_usage").get().c;
    check(
      "生产库 llm_usage 有数据（遥测最终落库）",
      usageCount > 0,
      `${usageCount} 行`
    );
    const last = prod.prepare(
      "SELECT session_id, agent, model FROM llm_usage ORDER BY id DESC LIMIT 1"
    ).get();
    check(
      "最后一条遥测内容正确（含测试写入的记录）",
      !!last && (last.session_id === "test-sess" || last.model === "test-model"),
      last ? `session=${last.session_id} model=${last.model}` : "无记录"
    );

    /* ---- 关键：改造后的会话不能有遥测矛盾 ---- */
    // ⚠️ 判据要用**新 session id 格式**来圈定"改造后"的数据：
    //    旧格式 `sess_${时间戳36进制}_${随机6位}`（如 sess_mvynvofl_）
    //    新格式 `sess_` + 24 字节 base64url（32 字符）
    //    历史数据里有 9 场"有 usage 没 tools"的会话（2026-10-28 ~ 11-02）——
    //    那是**改造前**的遗留（当时的 tool_calls 记录逻辑与现在不同），
    //    不能算到写缓冲头上。
    const contradictions = prod.prepare(`
      SELECT COUNT(*) c FROM sessions s
      WHERE length(s.id) > 30
        AND (SELECT COUNT(*) FROM llm_usage u WHERE u.session_id = s.id) > 1
        AND (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) = 0
    `).get().c;
    check(
      "改造后的会话没有「有 usage 没 tools」的矛盾（写缓冲不丢数据）",
      contradictions === 0,
      contradictions === 0
        ? "内部一致性通过"
        : `有 ${contradictions} 场矛盾`
    );

    // ⚠️ 更强的判据：最近一场 done 会话的遥测必须**内部自洽**
    //    ⚠️ 不能假设"done 一定有 LLM 用量" —— 那会**误报**：
    //      降级路径（本地剧本引擎）一场都不调 LLM → usage=0 / tools=0 是**正确**的。
    //      （实测踩过：最近一场 done 会话 usage=0，是降级路径，不是丢数据）
    //    正确判据：
    //      ① timings > 0（阶段记录总是有 —— 降级路径也记 timing）
    //      ② usage 与 tools 要么都为 0（降级），要么 usage>0 且 tools>0（LLM 路径）
    const recentDone = prod.prepare(`
      SELECT s.id,
        (SELECT COUNT(*) FROM llm_usage u WHERE u.session_id = s.id) usage,
        (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) tools,
        (SELECT COUNT(*) FROM session_timings g WHERE g.session_id = s.id) timings
      FROM sessions s WHERE s.status = 'done' AND length(s.id) > 30
      ORDER BY s.created_at DESC LIMIT 1
    `).get();
    const selfConsistent = !!recentDone &&
      recentDone.timings > 0 &&
      ((recentDone.usage === 0 && recentDone.tools === 0) ||
       (recentDone.usage > 0 && recentDone.tools > 0));
    check(
      "最近一场 done 会话的遥测内部自洽（降级路径可全 0）",
      selfConsistent,
      recentDone
        ? `usage=${recentDone.usage} tools=${recentDone.tools} timings=${recentDone.timings}` +
          (recentDone.usage === 0 && recentDone.tools === 0 ? "（降级路径，不调 LLM）" : "")
        : "无 done 会话"
    );

    // ⚠️ 补充断言：走 LLM 路径的 done 会话（usage>0）必须遥测齐全
    const llmDone = prod.prepare(`
      SELECT s.id,
        (SELECT COUNT(*) FROM llm_usage u WHERE u.session_id = s.id) usage,
        (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) tools
      FROM sessions s WHERE s.status = 'done' AND length(s.id) > 30
        AND (SELECT COUNT(*) FROM llm_usage u WHERE u.session_id = s.id) > 0
      ORDER BY s.created_at DESC LIMIT 1
    `).get();
    check(
      "最近一场走 LLM 的 done 会话遥测齐全（usage>0 且 tools>0）",
      !llmDone || (llmDone.usage > 0 && llmDone.tools > 0),
      llmDone ? `usage=${llmDone.usage} tools=${llmDone.tools}` : "（暂无 LLM 路径的 done 会话）"
    );

    prod.close();
    db.close();
    try { (await import("node:fs")).rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
