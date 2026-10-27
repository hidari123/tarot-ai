"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";

/**
 * 观测面板 —— Agent 系统运行数据一览
 * 会话统计 / 工具调用频次与延迟 / token 消耗 / 最近解读回看
 */

interface Stats {
  totalSessions: number;
  doneSessions: number;
  totalToolCalls: number;
  totalTokens: number;
  avgLlmLatencyMs: number;
  toolBreakdown: { tool: string; count: number; avgMs: number }[];
  staleSessions: { id: string; question: string; createdAt: number; ageMinutes: number }[];
  errorBreakdown: { reason: string; count: number }[];
  agentStats: {
    agent: string; calls: number; avgPromptTokens: number; avgCompletionTokens: number; avgMs: number;
  }[];
  promptVersions: {
    version: string; sessions: number; doneSessions: number;
    avgReadingChars: number; avgGrounding: number;
  }[];
  recentSessions: {
    id: string; question: string; persona: string; status: string;
    reading: string; cards: { nameZh: string; reversed: boolean; pos: string }[]; createdAt: number;
    errorReason?: string;
  }[];
}

const TOOL_LABEL: Record<string, string> = {
  rag_search: "📖 典籍检索",
  draw_cards: "🃏 命运抽牌",
  ask_user: "💭 澄清提问",
  offer_card_selection: "🎴 亲手选牌",
  fate_crossroads: "🔮 命运岔路",
  write_reading: "✍️ 解读撰写",
  analyze: "🔍 牌意分析",
};

const AGENT_LABEL: Record<string, string> = {
  supervisor: "🎭 编排者",
  analyst: "🔍 分析师",
  writer: "✍️ 撰写者",
  reviewer: "🧐 审校者",
};

const ERROR_REASON_LABEL: Record<string, string> = {
  client_disconnect: "客户端断开",
  engine_exception: "引擎异常",
  llm_error: "模型调用失败",
  deadline_exceeded: "超时中止",
  max_rounds: "超出最大轮次",
  stale_timeout: "僵死超时",
  ttl_expired: "会话过期",
  unknown: "未知原因",
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true);
    setError("");
    fetch("/api/dashboard")
      .then(async (r) => {
        if (!r.ok) throw new Error(`面板接口异常(${r.status})`);
        const d = await r.json();
        // ⚠️ 接口失败返回 {error}：直接 setStats 会让下方 stats.staleSessions.length 抛 TypeError 炸掉整页
        if (!d || typeof d.totalSessions !== "number") throw new Error(d?.error || "面板数据格式异常");
        setStats(d as Stats);
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "面板加载失败");
        setLoading(false);
      });
  };

  useEffect(() => {
    // 异步加载（setState 都在 Promise 回调里，避免 effect 内同步 setState）
    const t0 = setTimeout(load, 0);
    // 30s 轮询：面板是观测工具，数据新鲜度比省请求重要
    const t = setInterval(load, 30_000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, []);

  return (
    <main className="relative min-h-screen bg-[#05020a] px-4 py-10 md:py-14">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-purple-100 tracking-wide" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
              🔮 观测面板
            </h1>
            <p className="text-purple-300/50 text-sm mt-1">Agent 系统运行数据 · SQLite 持久化</p>
          </div>
          <Link
            href="/"
            className="px-5 py-2.5 rounded-full border border-purple-500/40 text-purple-200 hover:bg-purple-900/40 transition-all text-sm"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            ← 返回占卜
          </Link>
        </div>

        {loading && !stats && <p className="text-purple-300/60 text-center py-20 animate-pulse">星辰数据汇聚中…</p>}

        {error && !stats && (
          <div className="rounded-2xl border border-rose-500/40 bg-rose-950/20 px-6 py-10 text-center">
            <p className="text-rose-200/90 mb-4">{error}</p>
            <button
              onClick={load}
              className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-purple-700 to-indigo-700 text-white text-sm"
            >
              重新加载
            </button>
          </div>
        )}

        {stats && (
          <>
            {/* 统计卡片 */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
              {[
                { label: "占卜会话", value: stats.totalSessions, icon: "🎭" },
                { label: "完成解读", value: stats.doneSessions, icon: "✨" },
                { label: "工具调用", value: stats.totalToolCalls, icon: "🔧" },
                { label: "Token 消耗", value: stats.totalTokens.toLocaleString(), icon: "🪙" },
                { label: "LLM 平均延迟", value: `${stats.avgLlmLatencyMs}ms`, icon: "⚡" },
              ].map((c, i) => (
                <motion.div
                  key={c.label}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06 }}
                  className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur px-4 py-4"
                >
                  <div className="text-2xl mb-1">{c.icon}</div>
                  <div className="text-xl md:text-2xl font-bold text-purple-100 font-mono">{c.value}</div>
                  <div className="text-xs text-purple-300/50 mt-0.5">{c.label}</div>
                </motion.div>
              ))}
            </div>

            {/* ⚠️ 卡死会话警告 */}
            {stats.staleSessions.length > 0 && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-950/10 backdrop-blur p-5 mb-8">
                <h2 className="text-sm text-amber-200/90 tracking-wider mb-3">
                  ⚠️ 卡死会话（{stats.staleSessions.length}）· 超过 10 分钟仍在运行
                </h2>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {stats.staleSessions.map((s) => (
                    <div key={s.id} className="flex items-center gap-3 text-xs">
                      <span className="text-amber-300/80 font-mono shrink-0">{s.ageMinutes}min</span>
                      <span className="text-purple-200/70 truncate flex-1">{s.question}</span>
                      <span className="text-purple-400/40 font-mono shrink-0">{s.id.slice(-8)}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11px] text-amber-200/50">
                  这些会话在进程重启或客户端断开后遗留，服务启动时会自动对账清理（&gt;30min）。
                </p>
              </div>
            )}

            {/* 错误原因分布 */}
            {stats.errorBreakdown.length > 0 && (
              <div className="rounded-2xl border border-rose-500/20 bg-rose-950/10 backdrop-blur p-5 mb-8">
                <h2 className="text-sm text-rose-200/90 tracking-wider mb-3">❌ 异常会话原因分布</h2>
                <div className="flex flex-wrap gap-2">
                  {stats.errorBreakdown.map((e) => (
                    <span
                      key={e.reason}
                      className="px-3 py-1.5 rounded-lg bg-rose-500/10 border border-rose-400/20 text-xs text-rose-200/80"
                    >
                      {ERROR_REASON_LABEL[e.reason] ?? e.reason}
                      <span className="ml-2 font-mono text-rose-300/70">{e.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 各 Agent 的 token / 耗时明细（Trace 时间轴数据源） */}
            <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5 mb-8">
              <h2 className="text-sm text-purple-200/80 tracking-wider mb-4">🤖 各 Agent 性能明细</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-purple-400/50 border-b border-purple-500/15">
                      <th className="text-left py-2 pr-3">Agent</th>
                      <th className="text-right py-2 px-3">调用次数</th>
                      <th className="text-right py-2 px-3">平均 prompt tok</th>
                      <th className="text-right py-2 px-3">平均输出 tok</th>
                      <th className="text-right py-2 pl-3">平均耗时</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {stats.agentStats.map((a) => (
                      <tr key={a.agent} className="border-b border-purple-500/8">
                        <td className="py-2 pr-3 text-purple-200/80 font-sans">
                          {AGENT_LABEL[a.agent] ?? a.agent}
                        </td>
                        <td className="text-right py-2 px-3 text-purple-300/70">{a.calls}</td>
                        <td className="text-right py-2 px-3 text-purple-300/70">{a.avgPromptTokens}</td>
                        <td className="text-right py-2 px-3 text-purple-300/70">{a.avgCompletionTokens}</td>
                        <td
                          className={`text-right py-2 pl-3 ${
                            a.avgMs > 15000 ? "text-amber-300/90" : "text-purple-300/70"
                          }`}
                        >
                          {a.avgMs}ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {stats.agentStats.length === 0 && <p className="text-purple-300/40 text-sm py-4 text-center">暂无数据</p>}
            </div>

            {/* prompt 版本对比 */}
            {stats.promptVersions.length > 0 && (
              <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5 mb-8">
                <h2 className="text-sm text-purple-200/80 tracking-wider mb-4">📝 Prompt 版本效果</h2>
                <div className="space-y-2">
                  {stats.promptVersions.map((p) => (
                    <div key={p.version} className="flex items-center gap-3 text-xs">
                      <span className="px-2 py-0.5 rounded bg-purple-500/20 border border-purple-400/30 text-purple-200 font-mono">
                        {p.version}
                      </span>
                      <span className="text-purple-300/60">{p.sessions} 会话</span>
                      <span className="text-emerald-300/70">{p.doneSessions} 完成</span>
                      <span className="text-purple-300/50 ml-auto">
                        平均解读 {p.avgReadingChars} 字
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 工具调用统计 */}
            <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5 mb-8">
              <h2 className="text-sm text-purple-200/80 tracking-wider mb-4">🔧 工具调用频次与延迟</h2>
              {stats.toolBreakdown.length === 0 && <p className="text-purple-300/40 text-sm py-4 text-center">暂无数据</p>}
              <div className="space-y-3">
                {stats.toolBreakdown.map((t) => {
                  const max = Math.max(...stats.toolBreakdown.map((x) => x.count));
                  return (
                    <div key={t.tool} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 text-sm text-purple-200/80 truncate">{TOOL_LABEL[t.tool] ?? t.tool}</span>
                      <div className="flex-1 h-6 rounded-lg bg-black/30 overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${(t.count / max) * 100}%` }}
                          transition={{ duration: 0.8, ease: "easeOut" }}
                          className="h-full rounded-lg bg-gradient-to-r from-purple-600 to-fuchsia-500 flex items-center justify-end pr-2"
                        >
                          <span className="text-[11px] text-white/90 font-mono">{t.count}</span>
                        </motion.div>
                      </div>
                      <span className="w-20 shrink-0 text-right text-xs text-purple-300/50 font-mono">{t.avgMs}ms</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 最近解读 */}
            <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5">
              <h2 className="text-sm text-purple-200/80 tracking-wider mb-4">📜 最近占卜记录</h2>
              {stats.recentSessions.length === 0 && <p className="text-purple-300/40 text-sm py-4 text-center">还没有占卜记录</p>}
              <div className="space-y-3">
                {stats.recentSessions.map((s) => (
                  <div key={s.id} className="rounded-xl border border-purple-500/15 bg-black/20 px-4 py-3">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        s.status === "done" ? "bg-emerald-500/15 text-emerald-300" : s.status === "running" ? "bg-amber-500/15 text-amber-300" : "bg-rose-500/15 text-rose-300"
                      }`}>
                        {s.status === "done" ? "✓ 完成" : s.status === "running" ? "◉ 进行中" : "✗ 异常"}
                      </span>
                      <span className="text-sm text-purple-100/90">{s.question}</span>
                      <span className="ml-auto text-[11px] text-purple-300/40">
                        {new Date(s.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {s.cards.map((c, i) => (
                        <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-400/20 text-purple-200/80">
                          {c.pos} · {c.nameZh}{c.reversed ? "逆" : ""}
                        </span>
                      ))}
                    </div>
                    {s.reading && (
                      <p className="mt-2 text-xs text-purple-300/45 line-clamp-2 leading-relaxed">{s.reading.slice(0, 120)}…</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
