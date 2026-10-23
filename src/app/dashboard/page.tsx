"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

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
  recentSessions: {
    id: string; question: string; persona: string; status: string;
    reading: string; cards: { nameZh: string; reversed: boolean; pos: string }[]; createdAt: number;
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

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((r) => r.json())
      .then((d) => { setStats(d); setLoading(false); })
      .catch(() => setLoading(false));
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
          <a
            href="/"
            className="px-5 py-2.5 rounded-full border border-purple-500/40 text-purple-200 hover:bg-purple-900/40 transition-all text-sm"
            style={{ fontFamily: "'Ma Shan Zheng', serif" }}
          >
            ← 返回占卜
          </a>
        </div>

        {loading && <p className="text-purple-300/60 text-center py-20 animate-pulse">星辰数据汇聚中…</p>}

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
