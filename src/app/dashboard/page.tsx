"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import TraceTimeline from "@/components/TraceTimeline";
import Icon, { type IconName } from "@/components/icons";

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
    /** P2-⑧ 单场成本 */
    cost?: { tokens: number; estCny: number; llmCalls: number };
  }[];
  stageAggregates?: { stage: string; count: number; avgMs: number; totalMs: number }[];
  costEstimate?: { totalTokens: number; estCny: number };
  /** P2-⑧ 成本闭环：单场成本分布 */
  costPerSession?: {
    avgTokens: number; maxTokens: number; minTokens: number;
    avgCny: number; sessionCount: number;
  };
}

/**
 * ⚠️ 2026-11-04：emoji → SVG 图标（用户诉求："想要更漂亮一点的图标"）
 * ⚠️ 原因见 `src/components/icons.tsx` 的头注释：
 *   emoji 跨平台不一致（Windows/macOS/Android 三种长相）、
 *   Linux 上可能渲染成豆腐块、且与"暗紫金线"的古典调性不搭。
 *
 * ⚠️ 这里用 `IconName` 而不是字符串 —— 让**类型**保证图标名有效
 *   （写错名字会编译报错，而不是运行时渲染成空白）。
 */
const TOOL_META: Record<string, { icon: IconName; label: string }> = {
  rag_search: { icon: "book", label: "典籍检索" },
  draw_cards: { icon: "cards", label: "命运抽牌" },
  ask_user: { icon: "thought", label: "澄清提问" },
  offer_card_selection: { icon: "cards", label: "亲手选牌" },
  fate_crossroads: { icon: "scry", label: "命运岔路" },
  write_reading: { icon: "quill", label: "解读撰写" },
  analyze: { icon: "crystal", label: "牌意分析" },
};

const AGENT_META: Record<string, { icon: IconName; label: string }> = {
  supervisor: { icon: "masks", label: "编排者" },
  analyst: { icon: "magnify", label: "分析师" },
  writer: { icon: "quill", label: "撰写者" },
  reviewer: { icon: "eye", label: "审校者" },
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

/**
 * P1-④：令牌错误（401）的专用异常
 *
 * ⚠️ 为什么要单独一个类型：
 *   "令牌错了"（要重新输入）与"服务端出错了"（显示错误）是两种 UX，
 *   不能共用一个 catch 分支。
 */
class AuthError extends Error {}

/**
 * P1-④：拉取面板数据（带令牌）
 *
 * ⚠️ 抽成模块级函数的原因：
 *   三个地方要用（初始加载 / 提交令牌 / 轮询），
 *   各自写一遍会漂移（尤其是 401 的处理）。
 */
async function fetchStats(token: string): Promise<Stats> {
  const r = await fetch("/api/dashboard", { headers: { "X-Access-Token": token } });
  if (r.status === 401) throw new AuthError("访问令牌无效");
  if (!r.ok) throw new Error(`面板接口异常(${r.status})`);
  const d = await r.json();
  // ⚠️ 接口失败返回 {error}：直接 setStats 会让下方 stats.staleSessions.length 抛 TypeError 炸掉整页
  if (!d || typeof d.totalSessions !== "number") throw new Error(d?.error || "面板数据格式异常");
  return d as Stats;
}

/**
 * P1-④：令牌输入框
 *
 * ⚠️ 为什么用 type="password"：
 *   令牌不该以明文显示（肩窥/截图/录屏）。
 */
function TokenInput({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
      className="flex gap-2"
    >
      <input
        type="password"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="粘贴访问令牌"
        autoComplete="off"
        className="flex-1 px-4 py-2.5 rounded-xl bg-black/40 border border-purple-500/30 text-purple-100 text-sm outline-none focus:border-purple-400/60 placeholder:text-purple-300/30"
      />
      <button
        type="submit"
        disabled={!v.trim()}
        className="px-5 py-2.5 rounded-xl bg-purple-700/70 hover:bg-purple-600/70 text-white text-sm disabled:opacity-40 transition-colors"
      >
        进入
      </button>
    </form>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /**
   * P1-⑨：当前查看 trace 的会话 id
   * ⚠️ 用 state 而不是 ref —— 需要它触发 TraceTimeline 重新拉取，
   *    ref 的变化不会引起渲染。
   */
  const [traceSessionId, setTraceSessionId] = useState<string | null>(null);
  /**
   * P1-④：面板访问令牌
   *
   * ⚠️ 为什么存 sessionStorage 而不是 localStorage：
   *   localStorage 会**永久留在磁盘**（XSS 可读、共享电脑可读）。
   *   sessionStorage 关闭标签页即失效 —— 对"内部观测面板"够用。
   *
   * ⚠️ 为什么不放 URL query（?token=xxx）：
   *   URL 会被 referer 泄露、会被浏览器历史记录、会被截图分享出去。
   *   放 header 里更安全。
   */
  const [token, setToken] = useState<string>("");
  /** 是否已尝试过加载（用于区分"还没输入 token"与"token 错了"） */
  const [needToken, setNeedToken] = useState(false);


  /**
   * P1-④：从 sessionStorage 恢复令牌并加载
   *
   * ⚠️ 用 sessionStorage（不是 localStorage）：
   *   关闭标签页即失效 —— 对内部观测面板够用，且减少泄露面。
   */
  useEffect(() => {
    let saved = "";
    try {
      saved = sessionStorage.getItem("tarot:dashboardToken") ?? "";
    } catch { /* 隐私模式 */ }
    // ⚠️ 所有 setState 都放在 setTimeout 里（不在 effect 内同步调用）——
    //    React 的 "set-state-in-effect" 规则针对的是"根据 props/state 派生状态"，
    //    但同步 setState 也会造成一次额外的渲染。
    //    这里统一用异步推迟，既满足规则也避免级联渲染。
    if (!saved) {
      const t = setTimeout(() => {
        setNeedToken(true);
        setLoading(false);
      }, 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setToken(saved);
      fetchStats(saved)
        .then((d) => {
          setStats(d);
          setLoading(false);
        })
        .catch((e) => {
          // 401 → 需要输入令牌；其它错误 → 显示错误
          if (e instanceof AuthError) {
            setNeedToken(true);
            setLoading(false);
          } else {
            setError(e instanceof Error ? e.message : "面板加载失败");
            setLoading(false);
          }
        });
    }, 0);
    return () => clearTimeout(t);
  }, []);

  /**
   * P1-④：保存令牌并加载
   */
  const submitToken = useCallback((value: string) => {
    const t = value.trim();
    if (!t) return;
    try {
      sessionStorage.setItem("tarot:dashboardToken", t);
    } catch { /* 隐私模式：本次会话内仍可用 */ }
    setToken(t);
    setNeedToken(false);
    setStats(null);
    setLoading(true);
    fetchStats(t)
      .then((d) => {
        setStats(d);
        setLoading(false);
      })
      .catch((e) => {
        if (e instanceof AuthError) {
          setNeedToken(true);
          setLoading(false);
        } else {
          setError(e instanceof Error ? e.message : "面板加载失败");
          setLoading(false);
        }
      });
  }, []);

  // 30s 轮询（只在已有令牌时）
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => {
      fetchStats(token)
        .then((d) => setStats(d))
        .catch(() => { /* 轮询失败静默（下次再试） */ });
    }, 30_000);
    return () => clearInterval(t);
  }, [token]);

  return (
    <main className="relative min-h-screen bg-[#05020a] px-4 py-10 md:py-14">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-purple-100 tracking-wide flex items-center gap-2.5" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
              <Icon name="scry" size={28} className="text-purple-300/80" />
              观测面板
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

        {/* ---------- P1-④：令牌输入（面板需要鉴权）---------- */}
        {needToken && (
          <div className="max-w-md mx-auto mt-16 rounded-2xl border border-purple-500/30 bg-purple-950/25 backdrop-blur p-7">
            <h2 className="text-purple-100 text-lg mb-2" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
              需要访问令牌
            </h2>
            <p className="text-purple-300/60 text-xs mb-4 leading-relaxed">
              观测面板包含全站用户的占卜内容（私密），已启用访问保护。
              请输入部署时配置的 <code className="text-purple-200">DASHBOARD_TOKEN</code>。
            </p>
            <TokenInput onSubmit={submitToken} />
          </div>
        )}

        {loading && !stats && !needToken && <p className="text-purple-300/60 text-center py-20 animate-pulse">星辰数据汇聚中…</p>}

        {error && !stats && (
          <div className="rounded-2xl border border-rose-500/40 bg-rose-950/20 px-6 py-10 text-center">
            <p className="text-rose-200/90 mb-4">{error}</p>
            <button
              onClick={() => {
                // ⚠️ 重新加载：复用 submitToken（它会走 fetchStats + 统一错误处理）
                if (token) submitToken(token);
              }}
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
                { label: "占卜会话", value: stats.totalSessions, icon: "masks" as IconName },
                { label: "完成解读", value: stats.doneSessions, icon: "sparkle" as IconName },
                { label: "工具调用", value: stats.totalToolCalls, icon: "wand" as IconName },
                { label: "Token 消耗", value: stats.totalTokens.toLocaleString(), icon: "orbit" as IconName },
                { label: "LLM 平均延迟", value: `${stats.avgLlmLatencyMs}ms`, icon: "moon" as IconName },
              ].map((c, i) => (
                <motion.div
                  key={c.label}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06 }}
                  className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur px-4 py-4"
                >
                  <div className="mb-1 text-purple-300/70">
                    <Icon name={c.icon} size={22} />
                  </div>
                  <div className="text-xl md:text-2xl font-bold text-purple-100 font-mono">{c.value}</div>
                  <div className="text-xs text-purple-300/50 mt-0.5">{c.label}</div>
                </motion.div>
              ))}
            </div>

            {/* 方向③：延迟瀑布 + 成本估算 */}
            {stats.stageAggregates && stats.stageAggregates.length > 0 && (
              <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5 mb-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm text-purple-200/90 tracking-wider flex items-center gap-1.5"><Icon name="orbit" size={14} />阶段延迟瀑布（平均耗时 × 次数）</h2>
                  {stats.costEstimate && (
                    <span className="text-xs text-purple-300/50 font-mono flex items-center gap-1.5">
                      <Icon name="orbit" size={12} />
                      累计成本估算 ¥{stats.costEstimate.estCny}（{stats.costEstimate.totalTokens.toLocaleString()} tokens）
                    </span>
                  )}
                </div>

                {/* P2-⑧ 成本闭环：单场成本分布（毛利模型基础） */}
                {stats.costPerSession && stats.costPerSession.sessionCount > 0 && (
                  <div className="mb-4 flex flex-wrap items-center gap-3 text-[11px] text-purple-300/60 font-mono bg-purple-950/30 rounded-xl px-3 py-2">
                    <span className="text-purple-200/80 flex items-center gap-1.5">
                      <Icon name="scroll" size={12} />
                      单场成本（{stats.costPerSession.sessionCount} 场完成）：
                    </span>
                    <span>均值 {stats.costPerSession.avgTokens.toLocaleString()} tok / ¥{stats.costPerSession.avgCny}</span>
                    <span className="text-purple-400/50">|</span>
                    <span>峰值 {stats.costPerSession.maxTokens.toLocaleString()} tok</span>
                    <span className="text-purple-400/50">|</span>
                    <span>最低 {stats.costPerSession.minTokens.toLocaleString()} tok</span>
                  </div>
                )}
                <div className="space-y-2">
                  {stats.stageAggregates.slice(0, 10).map((s) => {
                    const maxMs = Math.max(...stats.stageAggregates!.map((x) => x.avgMs));
                    const pct = Math.max(3, Math.round((s.avgMs / (maxMs || 1)) * 100));
                    const stageLabel = s.stage
                      .replace("hitl_wait", "HITL 等待")
                      .replace("llm_supervisor", "LLM·supervisor")
                      .replace("llm_analyst", "LLM·analyst")
                      .replace("llm_writer", "LLM·writer")
                      .replace("llm_reviewer", "LLM·reviewer")
                      .replace("tool_rag_search", "工具·检索")
                      .replace("tool_", "工具·");
                    return (
                      <div key={s.stage} className="flex items-center gap-3 text-xs">
                        <span className="w-32 shrink-0 text-purple-200/70 truncate">{stageLabel}</span>
                        <div className="flex-1 h-4 rounded-full bg-purple-950/40 overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${pct}%` }}
                            transition={{ duration: 0.6 }}
                            className={`h-full rounded-full ${
                              s.avgMs > 10000 ? "bg-amber-500/70" : s.avgMs > 3000 ? "bg-purple-500/70" : "bg-sky-500/60"
                            }`}
                          />
                        </div>
                        <span className="w-24 shrink-0 text-right font-mono text-purple-300/60">
                          {s.avgMs >= 1000 ? `${(s.avgMs / 1000).toFixed(1)}s` : `${s.avgMs}ms`}
                        </span>
                        <span className="w-14 shrink-0 text-right font-mono text-purple-400/40">×{s.count}</span>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-3 text-[11px] text-purple-400/40">
                  瀑布揭示隐藏的耗时大头（如 HITL 等待常被忽略）；红色 &gt;10s、紫色 &gt;3s。
                </p>
              </div>
            )}

            {/* ⚠️ 卡死会话警告 */}
            {stats.staleSessions.length > 0 && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-950/10 backdrop-blur p-5 mb-8">
                <h2 className="text-sm text-amber-200/90 tracking-wider mb-3">
                  <span className="inline-flex items-center gap-1"><Icon name="orbit" size={12} />卡死会话（{stats.staleSessions.length}）· 超过 10 分钟仍在运行</span>
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
              <h2 className="text-sm text-purple-200/80 tracking-wider mb-4 flex items-center gap-1.5"><Icon name="masks" size={14} />各 Agent 性能明细</h2>
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
                        <td className="py-2 pr-3 text-purple-200/80 font-sans flex items-center gap-1.5">
                          {(() => {
                            const meta = AGENT_META[a.agent];
                            return meta ? (
                              <>
                                <Icon name={meta.icon} size={12} className="text-purple-300/70" />
                                {meta.label}
                              </>
                            ) : (
                              a.agent
                            );
                          })()}
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
                <h2 className="text-sm text-purple-200/80 tracking-wider mb-4 flex items-center gap-1.5"><Icon name="quill" size={14} />Prompt 版本效果</h2>
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
              <h2 className="text-sm text-purple-200/80 tracking-wider mb-4 flex items-center gap-1.5"><Icon name="wand" size={14} />工具调用频次与延迟</h2>
              {stats.toolBreakdown.length === 0 && <p className="text-purple-300/40 text-sm py-4 text-center">暂无数据</p>}
              <div className="space-y-3">
                {stats.toolBreakdown.map((t) => {
                  const max = Math.max(...stats.toolBreakdown.map((x) => x.count));
                  return (
                    <div key={t.tool} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 text-sm text-purple-200/80 truncate flex items-center gap-1.5">
                        {(() => {
                          const meta = TOOL_META[t.tool];
                          return meta ? (
                            <>
                              <Icon name={meta.icon} size={12} className="text-purple-300/70" />
                              {meta.label}
                            </>
                          ) : (
                            t.tool
                          );
                        })()}
                      </span>
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

            {/* P1-⑨：事件 Trace 时间轴（点下方会话切换） */}
            <TraceTimeline sessionId={traceSessionId} />

            {/* 最近解读 */}
            <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5">
              <h2 className="text-sm text-purple-200/80 tracking-wider mb-4">
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="scroll" size={14} />
                  最近占卜记录
                </span>
                <span className="ml-2 text-[11px] text-purple-300/40 font-normal">
                  点击任意一条查看它的过程时间轴
                </span>
              </h2>
              {stats.recentSessions.length === 0 && <p className="text-purple-300/40 text-sm py-4 text-center">还没有占卜记录</p>}
              <div className="space-y-3">
                {stats.recentSessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setTraceSessionId((cur) => (cur === s.id ? null : s.id))}
                    className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                      traceSessionId === s.id
                        ? "border-purple-400/40 bg-purple-500/10"
                        : "border-purple-500/15 bg-black/20 hover:border-purple-400/30 hover:bg-purple-500/5"
                    }`}
                  >
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
                      {/* P2-⑧ 单场成本徽章 */}
                      {s.cost && s.cost.tokens > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-amber-500/10 border border-amber-400/20 text-amber-200/70" title={`${s.cost.llmCalls} 次 LLM 调用`}>
                          ¥{s.cost.estCny} · {(s.cost.tokens / 1000).toFixed(1)}k tok
                        </span>
                      )}
                    </div>
                    {s.reading && (
                      <p className="mt-2 text-xs text-purple-300/45 line-clamp-2 leading-relaxed">{s.reading.slice(0, 120)}…</p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
