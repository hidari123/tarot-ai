"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  unlockAmbience,
  setMuted,
  setVolume,
  setScoreEnabled,
  setStyle,
  setAmbienceLayer,
  subscribeMuted,
  subscribeVolume,
  subscribeScoreEnabled,
  subscribeStyle,
  getMutedSnapshot,
  getVolumeSnapshot,
  getScoreEnabledSnapshot,
  getStyleSnapshot,
  getMutedServerSnapshot,
  getVolumeServerSnapshot,
  getScoreEnabledServerSnapshot,
  getStyleServerSnapshot,
  MATERIALS,
  STYLE_ORDER,
  type ScoreStyle,
} from "@/lib/audio";

/**
 * 配乐控制 —— 仿 Windows 任务栏的音量飞出窗
 *
 * ⚠️⚠️ 为什么是"一个按钮 + 弹出面板"（沿用旧设计的心智模型）：
 *   旧实现有两个常驻按钮（一个展开滑块、一个切静音），
 *   看起来像"两个功能"，但 Windows 任务栏的音量图标是**一个**：
 *   点它 → 弹出一个音量面板 → 面板里既能拖音量、又能静音。
 *
 * ⚠️ 面板内的元素分工：
 *   · 扬声器按钮（常驻）= **打开/关闭面板**
 *   · 面板内 ♪ 按钮     = **配乐层开/关**（不是总静音）
 *   · 面板内 音量滑块   = **总音量**
 *   · 面板内 风格按钮   = **星玻璃 / 深海低语**
 *
 * ⚠️ 首次提示气泡：
 *   浏览器禁止无手势自动播放 → 必须有一次真实点击才能解锁音频上下文。
 *   所以提示气泡就挂在按钮旁边，点它 = 解锁 + 开声（这一次点击就是手势）。
 *
 * ⚠️ 状态用 useSyncExternalStore 而不是 useState + useEffect：
 *   静音/音量/风格状态存在模块级单例里（跨组件共享），
 *   用 useEffect 去同步会触发 React 19 的 `set-state-in-effect` 规则
 *   —— 那不是"为了过 lint 而绕过"，而是真的多一次渲染。
 */
export default function AmbienceToggle() {
  const muted = useSyncExternalStore(
    subscribeMuted,
    getMutedSnapshot,
    getMutedServerSnapshot
  );
  const volume = useSyncExternalStore(
    subscribeVolume,
    getVolumeSnapshot,
    getVolumeServerSnapshot
  );
  const scoreEnabled = useSyncExternalStore(
    subscribeScoreEnabled,
    getScoreEnabledSnapshot,
    getScoreEnabledServerSnapshot
  );
  const style = useSyncExternalStore(
    subscribeStyle,
    getStyleSnapshot,
    getStyleServerSnapshot
  );
  /**
   * ⚠️ "是否已在客户端"的判断
   * getSnapshot 在服务端返回 false、客户端返回 true，
   * React 会**自动**在 hydration 后重渲染 —— 零额外渲染。
   */
  const isClient = useSyncExternalStore(emptySubscribe, getTrue, getFalse);
  /** 面板是否展开（纯组件本地状态，用普通 useState 就好） */
  const [showPanel, setShowPanel] = useState(false);
  /** 提示气泡是否已被用户点掉（点过一次就不再打扰） */
  const [hintDismissed, setHintDismissed] = useState(false);
  /** 面板 DOM 引用（用于点外面关闭） */
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 触发按钮的 DOM 引用（点外面关闭时不能把按钮本身当"外面"） */
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  /**
   * ⚠️ 首次提示的可见性（2026-11-13 改版）
   *
   * ⚠️⚠️ 用户反馈：「右上角的本页有配乐那里很丑」
   *   「打开之后怎么是两个按钮呢？应该只出现一个框才对」
   *
   * ⚠️⚠️ 旧设计的问题：
   *   · 右上角**并排两个元素**（扬声器 + 紫底胶囊「本页有配乐·点击开启」）
   *     → 看着像两个不相干的东西，且胶囊常驻占位 ❌
   *   · 点了胶囊 → 扬声器按钮**还在** → 变成"两个按钮" ❌
   *
   * ⚠️ 改法（对齐业界：Spotify / YouTube / Notion 都是**单个图标**）：
   *   · **删掉胶囊气泡** → 右上角只剩一个图标 ✅
   *   · 未开启时给图标加**脉冲光圈** → 暗示"这里可以点"（不增加元素）✅
   *   · 点击图标 → 弹出面板（音量 / 配乐开关 / 风格）✅
   */
  const showHint = isClient && !hintDismissed && muted;

  const togglePanel = useCallback(() => {
    /**
     * ⚠️⚠️ 2026-11-13 改版：**未开启时，第一次点击直接开声音**（不开面板）
     * ⚠️ 用户反馈：「打开之后怎么是两个按钮呢？应该只出现一个框才对」
     * ⚠️ 旧行为：点图标 → 只开面板 → 还要再点面板里的 ♪ 才有声音 → 两步
     * ⚠️ 新行为（对齐手机静音键 / Spotify）：
     *   · 静音状态点图标 → **直接开声音**（一次点击就有反馈）✅
     *   · 已开启状态点图标 → **弹出面板**（调音量/风格）✅
     */
    if (muted) {
      setHintDismissed(true);
      void (async () => {
        await unlockAmbience();
        setMuted(false);
      })();
      return;
    }
    setShowPanel((v) => !v);
  }, [muted]);

  /**
   * ⚠️ 面板里的配乐开关
   * 开：先 unlock（**必须在用户手势的同步上下文里**，AudioContext.resume() 才成功），再取消静音。
   * 关：只关配乐层（事件音效与空气层保留）—— 用户可能想只听翻牌声。
   */
  const toggleMusic = useCallback(async () => {
    if (muted) {
      await unlockAmbience();
      setMuted(false);
      setHintDismissed(true);
    } else if (scoreEnabled) {
      setScoreEnabled(false);
    } else {
      setScoreEnabled(true);
    }
  }, [muted, scoreEnabled]);

  const onVolume = useCallback((v: number) => {
    setVolume(v);
    // ⚠️ 拖动音量 = 用户想要声音 → 自动取消静音
    if (v > 0 && muted) {
      setMuted(false);
      setHintDismissed(true);
    }
  }, [muted]);

  const onStyle = useCallback((s: ScoreStyle) => {
    setStyle(s);
  }, []);

  /**
   * ⚠️ 点击面板外部 → 关闭面板（Windows 飞出窗的经典行为）
   * 用 pointerdown（而不是 click）：按下即判断，手感更利落。
   */
  useEffect(() => {
    if (!showPanel) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setShowPanel(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPanel(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showPanel]);

  if (!isClient) {
    return <div className="w-9 h-9" aria-hidden="true" />;
  }

  return (
    <div className="relative">
      {/* ---------- 唯一常驻按钮：扬声器 ---------- */}
      {/**
       * ⚠️⚠️ 相对位置 + 脉冲光圈（2026-11-13 改版）
       * ⚠️ 用户要求：「不用提示（图标脉冲提示）」
       *
       * ⚠️ 为什么脉冲圈要**绝对定位**在按钮**后面**：
       *   · 光圈比按钮大 → 会溢出按钮的 border-radius 边界
       *   · 用 relative 包裹 + absolute 光圈（z 低于按钮）→ 扩散在按钮外 ✅
       *   · 不加 relative 的话光圈会撑开布局 → 右上角被顶偏 ❌
       */}
      <div className="relative">
        {showHint && (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              background:
                "radial-gradient(circle, rgba(212,175,55,0.55) 0%, rgba(212,175,55,0) 70%)",
              animation: "ambience-pulse 2.8s ease-in-out infinite",
            }}
          />
        )}
        <button
          ref={buttonRef}
          type="button"
          onClick={togglePanel}
          aria-label={
            showPanel
              ? "收起音乐音量面板"
              : muted
                ? "开启配乐"
                : "打开音乐音量面板"
          }
          aria-expanded={showPanel}
          title={showPanel ? "收起面板" : muted ? "开启配乐" : "音乐与音量"}
          className={`relative w-9 h-9 flex items-center justify-center rounded-full border transition-colors ${
            showPanel
              ? "border-purple-400/40 bg-purple-500/15 text-purple-100"
              : "border-white/10 bg-white/5 text-white/60 hover:text-white/90 hover:bg-white/10"
          }`}
        >
          {muted ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path d="m22 9-6 6M16 9l6 6" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              {volume > 0.5 && <path d="M18.5 5.5a9 9 0 0 1 0 13" />}
            </svg>
          )}
        </button>
      </div>

      {/* ---------- 弹出面板 ---------- */}
      <AnimatePresence>
        {showPanel && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className="absolute right-0 top-11 z-10 w-64 rounded-2xl border border-white/10 bg-[#14121f]/95 backdrop-blur-md shadow-2xl shadow-black/40 p-3"
          >
            {/* 标题行 */}
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] tracking-[0.2em] text-white/45">占卜配乐</span>
              {/* 面板内的配乐开关（♪） */}
              <button
                type="button"
                onClick={() => void toggleMusic()}
                aria-label={scoreEnabled ? "关闭配乐" : "开启配乐"}
                title={scoreEnabled ? "关闭配乐" : "开启配乐"}
                className={`w-8 h-8 flex items-center justify-center rounded-full border transition-colors ${
                  scoreEnabled && !muted
                    ? "border-purple-400/40 bg-purple-500/20 text-purple-200"
                    : "border-white/10 bg-white/5 text-white/35 hover:text-white/70"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18V5l12-2v13" />
                  <circle cx="6" cy="18" r="3" />
                  <circle cx="18" cy="16" r="3" />
                </svg>
              </button>
            </div>

            {/* 音量滑块 */}
            <div className="flex items-center gap-2.5">
              <svg
                width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round"
                className={muted ? "text-white/25" : "text-white/55"}
              >
                <path d="M11 5 6 9H2v6h4l5 4V5z" />
                {muted ? (
                  <path d="m22 9-6 6M16 9l6 6" />
                ) : (
                  <>
                    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                    {volume > 0.5 && <path d="M18.5 5.5a9 9 0 0 1 0 13" />}
                  </>
                )}
              </svg>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => onVolume(Number(e.target.value) / 100)}
                aria-label="配乐音量"
                className="flex-1 h-1 accent-purple-400 cursor-pointer"
              />
              <span className="text-[11px] text-white/50 font-mono w-9 text-right tabular-nums">
                {Math.round(volume * 100)}
              </span>
            </div>

            {/* 风格切换 */}
            <div className="mt-3">
              <div className="text-[10px] tracking-[0.18em] text-white/35 mb-1.5">风格</div>
              <div className="grid grid-cols-2 gap-1.5">
                {STYLE_ORDER.map((s) => {
                  const active = style === s;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onStyle(s)}
                      aria-pressed={active}
                      title={MATERIALS[s].mood}
                      className={`rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${
                        active
                          ? "border-purple-400/50 bg-purple-500/20 text-purple-100"
                          : "border-white/10 bg-white/5 text-white/50 hover:text-white/80"
                      }`}
                    >
                      {MATERIALS[s].label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">
                {MATERIALS[style].mood}
              </p>
            </div>

            {/* 状态提示 */}
            <p className="mt-2.5 text-[10px] text-white/30">
              {muted
                ? "音乐已关闭"
                : scoreEnabled
                  ? "拖动滑块调节音量 · 点音符按钮可关闭配乐"
                  : "配乐已关 · 只保留翻牌与仪式音效"}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 阶段 → 配乐的联动 hook
 *
 * ⚠️ 放在独立文件里是为了让主页面**只 import 一个 hook**，
 *    而不是把 phase 映射的细节散进主组件。
 *
 * ⚠️ 为什么不再有 "enabled" 开关：
 *    旧实现只在"占卜进行中"启用（待机页不该有声音）——
 *    那是因为当时的待机层只是沙沙的底噪。待机层现在是真正的"等待音乐"，
 *    首页就该有（浏览器自动播放策略也决定了：用户不点就永远不会响）。
 */
export function useAmbiencePhase(phase: string | null | undefined): void {
  useEffect(() => {
    setAmbienceLayer(phase);
  }, [phase]);
}

/* ---- 内部工具 ---- */

const emptySubscribe = () => () => {};
const getFalse = () => false;
const getTrue = () => true;
