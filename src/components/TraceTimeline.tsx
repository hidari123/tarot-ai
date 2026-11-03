"use client";

/**
 * 事件 trace 时间轴（P1-⑨）
 *
 * ⚠️ 这个组件解决什么问题：
 *   dashboard 之前只有**聚合数据**（总会话数、token 总量、平均延迟），
 *   想知道"某一场占卜到底发生了什么"只能去翻数据库。
 *   而排查问题的第一需求恰恰是**单场的过程可见性**：
 *     - 承约/呼召/选牌/翻牌/讲牌 各花了多久？
 *     - 哪一步卡住了？
 *     - 仪式顺序对不对（有没有跳过承约）？
 *
 * ⚠️ 设计取舍：
 *   1. **时间轴 + 相对时刻**：绝对时间戳意义不大，
 *      "第 3 步发生在开场后 42 秒"才是排查时真正要看的。
 *   2. **事件类型可折叠**：一场占卜 20~60 条事件，
 *      默认只展开"结构性事件"（phase/tool/card_*），delta 这类高频的折叠。
 *   3. **点击会话即加载**：不做全库预取 —— 数据量与延迟都不划算。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

/** 单条事件（与 /api/dashboard/events 的返回对应） */
interface TraceEvent {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: number;
}

/** 事件类型 → 展示名 + 颜色（把"协议名"翻译成"人话"） */
const EVENT_META: Record<string, { label: string; dot: string; group: "flow" | "tool" | "card" | "llm" | "user" }> = {
  session: { label: "会话建立", dot: "bg-slate-400", group: "flow" },
  phase: { label: "阶段切换", dot: "bg-purple-400", group: "flow" },
  contract: { label: "承约", dot: "bg-amber-400", group: "flow" },
  invocation: { label: "呼召", dot: "bg-amber-400", group: "flow" },
  ask_user: { label: "等待用户", dot: "bg-cyan-400", group: "user" },
  cards: { label: "牌阵", dot: "bg-fuchsia-400", group: "card" },
  card_flip_ready: { label: "可翻牌", dot: "bg-fuchsia-400", group: "card" },
  card_reveal: { label: "翻牌", dot: "bg-fuchsia-400", group: "card" },
  card_reading: { label: "讲牌", dot: "bg-fuchsia-400", group: "card" },
  tool: { label: "工具调用", dot: "bg-emerald-400", group: "tool" },
  rag_hits: { label: "典籍检索", dot: "bg-emerald-400", group: "tool" },
  subagent: { label: "子 Agent", dot: "bg-blue-400", group: "llm" },
  review: { label: "审校", dot: "bg-blue-400", group: "llm" },
  round: { label: "轮次", dot: "bg-slate-500", group: "llm" },
  nudge: { label: "等待提醒", dot: "bg-cyan-400", group: "user" },
  done: { label: "完成", dot: "bg-emerald-400", group: "flow" },
  error: { label: "错误", dot: "bg-rose-400", group: "flow" },
};

/** 高频事件默认折叠（一次占卜的 delta 可能有几百条） */
const NOISY_TYPES = new Set(["delta", "reasoning"]);

export default function TraceTimeline({ sessionId }: { sessionId: string | null }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNoisy, setShowNoisy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    setLoading(true);
    setErr("");
    // ⚠️ P1-④：面板事件接口需要访问令牌（与 dashboard 同一套）
    //    令牌从 sessionStorage 读（与 dashboard 页保持一致）
    let token = "";
    try {
      token = sessionStorage.getItem("tarot:dashboardToken") ?? "";
    } catch { /* 隐私模式 */ }
    fetch(`/api/dashboard/events?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: token ? { "X-Access-Token": token } : {},
    })
      .then(async (r) => {
        if (r.status === 401) throw new Error("需要访问令牌（请重新输入面板令牌）");
        if (!r.ok) throw new Error(`事件接口异常(${r.status})`);
        const d = await r.json();
        setEvents(Array.isArray(d.events) ? d.events : []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "事件加载失败"))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    // ⚠️ 为什么用 setTimeout(0) 触发而不是直接调 load()：
    //    load() 里有同步的 setState(setLoading(true))，
    //    在 effect 里同步 setState 会触发 React 的
    //    react-hooks/set-state-in-effect 规则（effect 不该产生同步的渲染更新）。
    //    延迟到下一个宏任务，等价于"异步加载"且不违反规则。
    //    （与 dashboard/page.tsx 的 load 逻辑同一手法）
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  const shown = useMemo(
    () => (showNoisy ? events : events.filter((e) => !NOISY_TYPES.has(e.type))),
    [events, showNoisy]
  );
  const hiddenCount = events.length - shown.length;

  /** 相对开场时刻的偏移（秒） */
  const t0 = events.length > 0 ? events[0].createdAt : 0;
  const rel = (t: number) => (t0 ? `+${((t - t0) / 1000).toFixed(1)}s` : "");

  if (!sessionId) {
    return (
      <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5 mb-8">
        <h2 className="text-sm text-purple-200/80 tracking-wider mb-3">🔍 事件 Trace 时间轴</h2>
        <p className="text-xs text-purple-300/40 py-3 text-center">
          在下方「最近占卜记录」里点击某一场，查看它的完整过程时间轴
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-purple-500/20 bg-purple-950/20 backdrop-blur p-5 mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="text-sm text-purple-200/80 tracking-wider">
          🔍 事件 Trace 时间轴
          <span className="ml-2 text-[11px] text-purple-300/40 font-mono">
            {sessionId}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowNoisy((v) => !v)}
              className="text-[11px] text-purple-300/50 hover:text-purple-200/80 underline underline-offset-2"
            >
              {showNoisy ? "隐藏" : "显示"} {hiddenCount} 条正文/思考事件
            </button>
          )}
          <button
            onClick={load}
            className="text-[11px] text-purple-300/50 hover:text-purple-200/80"
            title="重新加载"
          >
            ↻ 刷新
          </button>
        </div>
      </div>

      {loading && <p className="text-xs text-purple-300/40 py-3 text-center">加载中…</p>}
      {err && <p className="text-xs text-rose-300/70 py-3 text-center">{err}</p>}
      {!loading && !err && shown.length === 0 && (
        <p className="text-xs text-purple-300/40 py-3 text-center">
          这场占卜没有记录到事件（旧会话或未落库）
        </p>
      )}

      {shown.length > 0 && (
        <div className="relative pl-4">
          {/* 时间轴竖线 */}
          <div className="absolute left-[5px] top-1 bottom-1 w-px bg-purple-500/20" />
          <div className="space-y-1">
            {shown.map((e) => {
              const meta = EVENT_META[e.type] ?? {
                label: e.type, dot: "bg-purple-500/50", group: "flow" as const,
              };
              const p = e.payload as Record<string, unknown>;
              // 提取一行摘要：不同事件类型的"关键信息"字段不一样
              const detail =
                (typeof p.label === "string" && p.label) ||
                (p.tool && typeof p.tool === "object"
                  ? String((p.tool as Record<string, unknown>).name ?? "")
                  : "") ||
                (typeof p.ask === "object" && p.ask
                  ? String((p.ask as Record<string, unknown>).kind ?? "")
                  : "") ||
                (typeof p.nudge === "object" && p.nudge
                  ? `level ${(p.nudge as Record<string, unknown>).level}`
                  : "") ||
                "";
              return (
                <div key={e.seq} className="flex items-start gap-3 py-0.5 group">
                  {/* 节点 */}
                  <span
                    className={`w-[7px] h-[7px] rounded-full mt-[7px] shrink-0 ${meta.dot} ${
                      e.type === "error" ? "animate-pulse" : ""
                    }`}
                  />
                  {/* 序号 + 时刻 */}
                  <span className="text-[10px] text-purple-300/30 font-mono tabular-nums mt-[3px] w-14 shrink-0">
                    #{e.seq} {rel(e.createdAt)}
                  </span>
                  {/* 类型 + 摘要 */}
                  <span className="text-[11px] text-purple-200/70 group-hover:text-purple-100/90 transition-colors">
                    {meta.label}
                    {detail && (
                      <span className="ml-1.5 text-purple-300/40 font-mono text-[10px]">
                        {String(detail).slice(0, 40)}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
