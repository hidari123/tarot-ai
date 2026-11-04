"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
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
 * 环境音开关 + 音量滑块
 *
 * ⚠️ 为什么是这个交互：
 *   浏览器禁止**无用户手势**的音频自动播放（Chrome/Safari 都拦）。
 *   所以音频**必须**由一次真实的点击来"解锁"。
 *   本组件承担三个职责：
 *     ① 用户主动开/关（这一次点击本身就是解锁手势）
 *     ② 音量调节（用户明确要求"提供滑块"）
 *     ③ 显示当前状态
 *
 * ⚠️ 另外："开始占卜"按钮也会调用 unlockAmbience() ——
 *   所以用户其实**不需要**先点这个按钮才能在占卜中听到声音。
 *   这个组件是给"我想先听听氛围 / 我想调音量"的用户的。
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
   *   React 19 的 `react-hooks/set-state-in-effect` 规则会拒绝
   *   "挂载后 setState 一次"这种模式（它确实多一次渲染）。
   *   useSyncExternalStore 的 getSnapshot 在服务端返回 false、客户端返回 true，
   *   React 会**自动**在 hydration 后重渲染 —— 零额外渲染。
   */
  const isClient = useSyncExternalStore(emptySubscribe, getTrue, getFalse);
  /** 滑块是否展开（纯组件本地状态，用普通 useState 就对） */
  const [showSlider, setShowSlider] = useState(false);

  const toggle = useCallback(async () => {
    const next = !muted;
    if (next) {
      // ⚠️ 必须先 unlock（这是用户手势的上下文），再取消静音
      await unlockAmbience();
      setMuted(false);
      setAmbienceLayer("idle");
    } else {
      setMuted(true);
    }
  }, [muted]);

  const onVolume = useCallback((v: number) => {
    setVolume(v);
    // ⚠️ 拖动音量 = 用户想要声音 → 自动取消静音
    if (v > 0 && muted) setMuted(false);
  }, [muted]);

  if (!isClient) {
    return <div className="w-9 h-9" aria-hidden="true" />;
  }

  return (
    <div className="flex items-center gap-2">
      {/* ⚠️ 音量滑块（用户要求）—— 展开式，不占常驻空间 */}
      <AnimatePresence>
        {showSlider && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 116 }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 pr-1">
              <span className="text-[10px] text-purple-300/50">音量</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => onVolume(Number(e.target.value) / 100)}
                aria-label="环境音音量"
                className="w-20 accent-purple-400 cursor-pointer"
              />
              <span className="text-[10px] text-purple-300/60 font-mono w-7 text-right">
                {Math.round(volume * 100)}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 音量滑块开关 */}
      <button
        type="button"
        onClick={() => setShowSlider((v) => !v)}
        aria-label={showSlider ? "收起音量滑块" : "展开音量滑块"}
        title="音量"
        className="w-9 h-9 flex items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 hover:text-white/90 hover:bg-white/10 transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          {volume > 0.02 ? (
            <>
              <path d="M15.5 8.5a5 5 0 0 1 0 7" />
              {volume > 0.5 && <path d="M18.5 5.5a9 9 0 0 1 0 13" />}
            </>
          ) : (
            <path d="m22 9-6 6M16 9l6 6" />
          )}
        </svg>
      </button>

      {/* 静音/有声开关 */}
      <button
        type="button"
        onClick={toggle}
        aria-label={muted ? "开启占卜环境音" : "关闭占卜环境音"}
        title={muted ? "开启环境音" : "关闭环境音"}
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
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
        )}
      </button>
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
