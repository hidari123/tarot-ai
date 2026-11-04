"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  unlockAmbience,
  setMuted,
  setVolume,
  setAmbienceLayer,
  ambienceForPhase,
  subscribeMuted,
  subscribeVolume,
  getMutedSnapshot,
  getVolumeSnapshot,
  getMutedServerSnapshot,
  getVolumeServerSnapshot,
  type AmbienceLayer,
} from "@/lib/audio/ambient";

/**
 * 环境音控制 —— 仿 Windows 任务栏的音量飞出窗
 *
 * ⚠️⚠️ 为什么是"一个按钮 + 弹出面板"（用户诉求：
 *   "音乐按钮不要两个，同一个按钮，点击打开拖拽的，旁边再展示一个音乐的按钮，
 *    点击可以关闭音乐，就像 windows 操作栏的一样"）：
 *   旧实现有两个常驻按钮（一个展开滑块、一个切静音），
 *   看起来像"两个功能"，但 Windows 任务栏的音量图标是**一个**：
 *   点它 → 弹出一个音量面板 → 面板里既能拖音量、又能静音。
 *   本组件完全对齐那个心智模型。
 *
 * ⚠️ 面板里的"音乐开关"按钮 vs 面板外的扬声器按钮：
 *   · 扬声器按钮 = **打开/关闭面板**（唯一常驻控件）
 *   · 面板内的 ♪ 按钮 = **开/关音乐**（开 = 解锁音频 + 取消静音）
 *   两个动作在不同层级，不会互相抢手势。
 *
 * ⚠️ 首次提示气泡（用户诉求："一开始先给个提示，说本页面有音乐，是否打开，
 *   放在右上角音乐那个按钮那边"）：
 *   浏览器禁止无手势自动播放 → 必须有一次真实的点击。
 *   所以提示气泡就挂在按钮旁边，点它 = 解锁 + 开音乐（这一次点击就是手势）。
 *   提示在"已解锁"后自动消失（由 muted 快照驱动，零额外状态）。
 *
 * ⚠️ 状态用 useSyncExternalStore 而不是 useState + useEffect：
 *   静音/音量状态存在模块级单例里（跨组件共享），
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
  /**
   * ⚠️ "是否已在客户端"的判断
   *
   * 用 useSyncExternalStore 而不是 useState+useEffect：
   * React 19 的 `react-hooks/set-state-in-effect` 规则会拒绝
   * "挂载后 setState 一次"这种模式（它确实多一次渲染）。
   * getSnapshot 在服务端返回 false、客户端返回 true，
   * React 会**自动**在 hydration 后重渲染 —— 零额外渲染。
   */
  const isClient = useSyncExternalStore(emptySubscribe, getTrue, getFalse);
  /** 面板是否展开（纯组件本地状态，用普通 useState 就对） */
  const [showPanel, setShowPanel] = useState(false);
  /** 提示气泡是否已被用户点掉（点过一次就不再打扰） */
  const [hintDismissed, setHintDismissed] = useState(false);
  /** 面板 DOM 引用（用于点外面关闭） */
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 触发按钮的 DOM 引用（点外面关闭时不能把按钮本身当"外面"） */
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  /**
   * ⚠️ 首次提示气泡的可见性
   *
   * 规则：音频**还没解锁**（muted 为 true 且未开过）→ 显示提示。
   * 一旦用户通过任何途径开声（点提示 / 点面板里的 ♪ / 点开始占卜），
   * muted 变 false → 提示自动消失。
   */
  const showHint = isClient && !hintDismissed && muted;

  const togglePanel = useCallback(() => {
    setShowPanel((v) => !v);
  }, []);

  /**
   * ⚠️ 面板里的音乐开关
   *
   * 开：先 unlock（**必须在用户手势的同步上下文里**，AudioContext.resume() 才成功），
   *    再取消静音、设 idle 层。
   * 关：静音（不销毁音频图 —— 下次开是无缝的）。
   */
  const toggleMusic = useCallback(async () => {
    if (muted) {
      await unlockAmbience();
      setMuted(false);
      setAmbienceLayer("idle");
      setHintDismissed(true);
    } else {
      setMuted(true);
    }
  }, [muted]);

  const onVolume = useCallback((v: number) => {
    setVolume(v);
    // ⚠️ 拖动音量 = 用户想要声音 → 自动取消静音
    if (v > 0 && muted) {
      setMuted(false);
      setHintDismissed(true);
    }
  }, [muted]);

  /**
   * ⚠️ 点击面板外部 → 关闭面板（Windows 飞出窗的经典行为）
   *
   * 用 pointerdown（而不是 click）：按下即判断，手感更利落。
   * ⚠️ 必须排除按钮自身，否则"点按钮收起"会先被这里的判断抢走。
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
    <div className="flex items-start gap-2">
      {/* ---------- 唯一常驻按钮：扬声器（Windows 任务栏音量图标） ---------- */}
      <button
        ref={buttonRef}
        type="button"
        onClick={togglePanel}
        aria-label={showPanel ? "收起音乐音量面板" : "打开音乐音量面板"}
        aria-expanded={showPanel}
        title="音乐与音量"
        className="w-9 h-9 flex items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 hover:text-white/90 hover:bg-white/10 transition-colors"
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

      {/* ---------- 首次提示气泡（"本页面有音乐，是否打开"） ----------
          ⚠️ 挂在按钮左边而不是盖住按钮 → 不挡任何操作。
          ⚠️ 点提示本身 = 解锁 + 开音乐（那一下点击就是浏览器要的手势）。 */}
      <AnimatePresence>
        {showHint && !showPanel && (
          <motion.button
            type="button"
            initial={{ opacity: 0, x: 8, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 8, scale: 0.96 }}
            transition={{ duration: 0.28 }}
            onClick={() => {
              setHintDismissed(true);
              void (async () => {
                await unlockAmbience();
                setMuted(false);
                setAmbienceLayer("idle");
              })();
            }}
            className="whitespace-nowrap rounded-full border border-purple-400/30 bg-purple-950/60 backdrop-blur-sm px-3 py-1.5 text-[11px] tracking-[0.18em] text-purple-200/80 hover:text-purple-100 hover:bg-purple-900/70 transition-colors"
          >
            本页有氛围乐 · 点击开启
          </motion.button>
        )}
      </AnimatePresence>

      {/* ---------- 弹出面板（Windows 音量飞出窗） ---------- */}
      <AnimatePresence>
        {showPanel && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className="w-64 rounded-2xl border border-white/10 bg-[#14121f]/95 backdrop-blur-md shadow-2xl shadow-black/40 p-3"
          >
            {/* 标题行 */}
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[11px] tracking-[0.2em] text-white/45">占卜氛围乐</span>
              {/* 面板内的音乐开关（♪）—— 点击开/关音乐 */}
              <button
                type="button"
                onClick={() => void toggleMusic()}
                aria-label={muted ? "开启音乐" : "关闭音乐"}
                title={muted ? "开启音乐" : "关闭音乐"}
                className={`w-8 h-8 flex items-center justify-center rounded-full border transition-colors ${
                  muted
                    ? "border-white/10 bg-white/5 text-white/35 hover:text-white/70"
                    : "border-purple-400/40 bg-purple-500/20 text-purple-200"
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
                aria-label="环境音音量"
                className="flex-1 h-1 accent-purple-400 cursor-pointer"
              />
              <span className="text-[11px] text-white/50 font-mono w-9 text-right tabular-nums">
                {Math.round(volume * 100)}
              </span>
            </div>

            {/* 状态提示 */}
            <p className="mt-2.5 text-[10px] text-white/30">
              {muted ? "音乐已关闭" : "拖动滑块调节音量 · 点音符按钮可关闭"}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * 阶段 → 氛围层的联动 hook
 *
 * ⚠️ 放在独立文件里是为了让主页面**只 import 一个 hook**，
 *    而不是把 phase 映射的细节散进主组件。
 */
export function useAmbiencePhase(phase: string | null | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const layer: AmbienceLayer = ambienceForPhase(phase);
    setAmbienceLayer(layer);
  }, [phase, enabled]);
}

/* ---- 内部工具 ---- */

const emptySubscribe = () => () => {};
const getFalse = () => false;
const getTrue = () => true;
