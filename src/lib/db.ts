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

export function finishSession(id: string, review: SessionRow["review"]): void {
  db.prepare(`UPDATE sessions SET review_json = ?, status = 'done', finished_at = ? WHERE id = ?`).run(
    JSON.stringify(review ?? null), Date.now(), id
  );
}

export function failSession(id: string): void {
  db.prepare(`UPDATE sessions SET status = 'error', finished_at = ? WHERE id = ?`).run(Date.now(), id);
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
  recentSessions: {
    id: string; question: string; persona: string; status: string;
    reading: string; cards: SessionRow["cards"]; createdAt: number;
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
    SELECT id, question, persona, status, reading, cards_json, created_at
    FROM sessions ORDER BY created_at DESC LIMIT 20
  `).all() as { id: string; question: string; persona: string; status: string; reading: string; cards_json: string; created_at: number }[];

  return {
    totalSessions: total.c,
    doneSessions: done.c,
    totalToolCalls: tools.c,
    totalTokens: tokens.t,
    avgLlmLatencyMs: Math.round(latency.a),
    toolBreakdown: breakdown.map((b) => ({ tool: b.tool, count: b.count, avgMs: Math.round(b.avgMs) })),
    recentSessions: recent.map((r) => ({
      id: r.id, question: r.question, persona: r.persona, status: r.status,
      reading: r.reading, cards: JSON.parse(r.cards_json), createdAt: r.created_at,
    })),
  };
}

export function getSessionReading(id: string): { reading: string; question: string; cards: SessionRow["cards"] } | null {
  const row = db.prepare(`SELECT reading, question, cards_json FROM sessions WHERE id = ?`).get(id) as
    { reading: string; question: string; cards_json: string } | undefined;
  if (!row) return null;
  return { reading: row.reading, question: row.question, cards: JSON.parse(row.cards_json) };
}
