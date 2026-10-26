/**
 * SQLite 持久层 —— 会话/解读/工具调用日志落库
 *
 * 表结构：
 *  sessions   一次占卜会话（问题/牌面/解读全文/人格/时间）
 *  tool_calls Agent 工具调用流水（审计 & dashboard 统计）
 *  llm_usage  LLM 调用统计（token 用量/延迟/模型）
 *
 * 文件：data/tarot.db（.gitignore 已排除）
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

// globalThis 单例（dev 多 worker 共享同一文件句柄）
const g = globalThis as unknown as { __tarotDb__?: Database.Database };
const db: Database.Database = g.__tarotDb__ ?? new Database(join(DATA_DIR, "tarot.db"));
g.__tarotDb__ = db;

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'mystic',
  cards_json TEXT NOT NULL DEFAULT '[]',
  reading TEXT NOT NULL DEFAULT '',
  review_json TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT 'supervisor',
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '{}',
  result_summary TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
`);

// ---- 迁移：新增 error_reason 字段（记录会话异常结束的原因） ----
try {
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "error_reason")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN error_reason TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.some((c) => c.name === "prompt_version")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN prompt_version TEXT NOT NULL DEFAULT ''`);
  }
} catch { /* 迁移失败不阻断 */ }

/* ---------------- 写入 API ---------------- */

export interface SessionRow {
  id: string;
  question: string;
  persona: string;
  cards: { id: string; nameZh: string; image: string; reversed: boolean; pos: string }[];
  reading: string;
  review: { pass: boolean; scores: { grounding: number; empathy: number; tone: number }; comment: string; rewritten?: boolean } | null;
  status: "running" | "done" | "error";
  createdAt: number;
  finishedAt?: number;
}

const stmtInsertSession = db.prepare(`
  INSERT INTO sessions (id, question, persona, cards_json, reading, review_json, status, created_at)
  VALUES (@id, @question, @persona, @cardsJson, '', 'null', 'running', @createdAt)
`);

export function insertSession(id: string, question: string, persona: string, cards: SessionRow["cards"]): void {
  stmtInsertSession.run({
    id, question, persona,
    cardsJson: JSON.stringify(cards),
    createdAt: Date.now(),
  });
}

export function updateSessionReading(id: string, reading: string): void {
  db.prepare(`UPDATE sessions SET reading = ? WHERE id = ?`).run(reading, id);
}

export function updateSessionCards(id: string, cards: SessionRow["cards"]): void {
  db.prepare(`UPDATE sessions SET cards_json = ? WHERE id = ?`).run(JSON.stringify(cards), id);
}

/** 记录本次会话使用的 prompt 版本（用于版本效果对比） */
export function updateSessionPromptVersion(id: string, version: string): void {
  db.prepare(`UPDATE sessions SET prompt_version = ? WHERE id = ?`).run(version, id);
}

export function finishSession(id: string, review: SessionRow["review"]): void {
  db.prepare(`UPDATE sessions SET review_json = ?, status = 'done', finished_at = ? WHERE id = ?`).run(
    JSON.stringify(review ?? null), Date.now(), id
  );
}

export function failSession(id: string, reason = "unknown"): void {
  db.prepare(`UPDATE sessions SET status = 'error', error_reason = ?, finished_at = ? WHERE id = ?`)
    .run(reason, Date.now(), id);
}

/**
 * 启动对账：把"僵死"的 running 会话标记为 error。
 *
 * 场景：进程重启 / 客户端断开 / 生成器被 GC —— 这些路径不会执行正常收尾，
 * 导致会话永远停在 running（实测占比高达 45%）。
 * 判据：status='running' 且最后活动时间超过阈值。
 */
export function reconcileStaleSessions(maxAgeMs = 30 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare(`
    UPDATE sessions
    SET status = 'error', error_reason = 'stale_timeout', finished_at = ?
    WHERE status = 'running' AND created_at < ?
  `).run(Date.now(), cutoff);
  return result.changes;
}

/** 列出僵死会话（dashboard 卡死视图用） */
export function listStaleSessions(maxAgeMs = 10 * 60 * 1000): {
  id: string; question: string; createdAt: number; ageMinutes: number;
}[] {
  const cutoff = Date.now() - maxAgeMs;
  const rows = db.prepare(`
    SELECT id, question, created_at FROM sessions
    WHERE status = 'running' AND created_at < ?
    ORDER BY created_at DESC LIMIT 50
  `).all(cutoff) as { id: string; question: string; created_at: number }[];
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    createdAt: r.created_at,
    ageMinutes: Math.round((now - r.created_at) / 60000),
  }));
}

export function logToolCall(
  sessionId: string, seq: number, agent: string, tool: string,
  args: Record<string, unknown>, resultSummary: string, durationMs: number
): void {
  db.prepare(`
    INSERT INTO tool_calls (session_id, seq, agent, tool, args_json, result_summary, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, seq, agent, tool, JSON.stringify(args ?? {}), resultSummary ?? "", durationMs ?? 0, Date.now());
}

export function logLLMUsage(
  sessionId: string | null, agent: string, model: string,
  promptTokens: number, completionTokens: number, durationMs: number, ok: boolean
): void {
  db.prepare(`
    INSERT INTO llm_usage (session_id, agent, model, prompt_tokens, completion_tokens, duration_ms, ok, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, agent, model, promptTokens, completionTokens, durationMs, ok ? 1 : 0, Date.now());
}

/* ---------------- 读取 API ---------------- */

export interface DashboardStats {
  totalSessions: number;
  doneSessions: number;
  totalToolCalls: number;
  totalTokens: number;
  avgLlmLatencyMs: number;
  toolBreakdown: { tool: string; count: number; avgMs: number }[];
  /** 僵死会话（超过 10 分钟仍在 running） */
  staleSessions: { id: string; question: string; createdAt: number; ageMinutes: number }[];
  /** 错误会话按原因分组 */
  errorBreakdown: { reason: string; count: number }[];
  /** 各 Agent 的 token/耗时明细（Trace 时间轴数据源） */
  agentStats: {
    agent: string; calls: number; avgPromptTokens: number; avgCompletionTokens: number; avgMs: number;
  }[];
  /** 按 prompt 版本的效果对比 */
  promptVersions: {
    version: string; sessions: number; doneSessions: number;
    avgReadingChars: number; avgGrounding: number;
  }[];
  recentSessions: {
    id: string; question: string; persona: string; status: string;
    reading: string; cards: SessionRow["cards"]; createdAt: number; errorReason?: string;
  }[];
}

export function getDashboardStats(): DashboardStats {
  const total = db.prepare(`SELECT COUNT(*) c FROM sessions`).get() as { c: number };
  const done = db.prepare(`SELECT COUNT(*) c FROM sessions WHERE status='done'`).get() as { c: number };
  const tools = db.prepare(`SELECT COUNT(*) c FROM tool_calls`).get() as { c: number };
  const tokens = db.prepare(`SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) t FROM llm_usage`).get() as { t: number };
  const latency = db.prepare(`SELECT COALESCE(AVG(duration_ms),0) a FROM llm_usage WHERE ok=1`).get() as { a: number };
  const breakdown = db.prepare(`
    SELECT tool, COUNT(*) count, COALESCE(AVG(duration_ms),0) avgMs
    FROM tool_calls GROUP BY tool ORDER BY count DESC
  `).all() as { tool: string; count: number; avgMs: number }[];
  const recent = db.prepare(`
    SELECT id, question, persona, status, reading, cards_json, created_at, error_reason
    FROM sessions ORDER BY created_at DESC LIMIT 20
  `).all() as { id: string; question: string; persona: string; status: string; reading: string; cards_json: string; created_at: number; error_reason: string }[];
  const errorBreakdown = db.prepare(`
    SELECT CASE WHEN error_reason = '' THEN 'unknown' ELSE error_reason END reason, COUNT(*) count
    FROM sessions WHERE status = 'error' GROUP BY reason ORDER BY count DESC
  `).all() as { reason: string; count: number }[];
  const agentStats = db.prepare(`
    SELECT agent, COUNT(*) calls,
           COALESCE(AVG(prompt_tokens),0) avgPt,
           COALESCE(AVG(completion_tokens),0) avgCt,
           COALESCE(AVG(duration_ms),0) avgMs
    FROM llm_usage GROUP BY agent ORDER BY avgMs DESC
  `).all() as { agent: string; calls: number; avgPt: number; avgCt: number; avgMs: number }[];
  const promptVersions = db.prepare(`
    SELECT prompt_version version, COUNT(*) sessions,
           SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) doneSessions,
           COALESCE(AVG(length(reading)),0) avgReading
    FROM sessions WHERE prompt_version != ''
    GROUP BY prompt_version ORDER BY prompt_version DESC
  `).all() as { version: string; sessions: number; doneSessions: number; avgReading: number }[];

  return {
    totalSessions: total.c,
    doneSessions: done.c,
    totalToolCalls: tools.c,
    totalTokens: tokens.t,
    avgLlmLatencyMs: Math.round(latency.a),
    toolBreakdown: breakdown.map((b) => ({ tool: b.tool, count: b.count, avgMs: Math.round(b.avgMs) })),
    staleSessions: listStaleSessions(),
    errorBreakdown: errorBreakdown.map((e) => ({ reason: e.reason, count: e.count })),
    agentStats: agentStats.map((a) => ({
      agent: a.agent,
      calls: a.calls,
      avgPromptTokens: Math.round(a.avgPt),
      avgCompletionTokens: Math.round(a.avgCt),
      avgMs: Math.round(a.avgMs),
    })),
    promptVersions: promptVersions.map((p) => ({
      version: p.version,
      sessions: p.sessions,
      doneSessions: p.doneSessions,
      avgReadingChars: Math.round(p.avgReading),
      avgGrounding: 0,
    })),
    recentSessions: recent.map((r) => ({
      id: r.id, question: r.question, persona: r.persona, status: r.status,
      reading: r.reading, cards: JSON.parse(r.cards_json), createdAt: r.created_at,
      errorReason: r.error_reason || undefined,
    })),
  };
}

export function getSessionReading(id: string): { reading: string; question: string; cards: SessionRow["cards"] } | null {
  const row = db.prepare(`SELECT reading, question, cards_json FROM sessions WHERE id = ?`).get(id) as
    { reading: string; question: string; cards_json: string } | undefined;
  if (!row) return null;
  return { reading: row.reading, question: row.question, cards: JSON.parse(row.cards_json) };
}
