"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  unlockAmbience,
  setMuted,
  setAmbienceLayer,
  ambienceForPhase,
  subscribeMuted,
  getMutedSnapshot,
  getMutedServerSnapshot,
  type AmbienceLayer,
} from "@/lib/audio/ambient";

/**
 * 环境音开关
 *
 * ⚠️ 为什么是这个交互：
 *   浏览器禁止**无用户手势**的音频自动播放（Chrome/Safari 都拦）。
 *   所以音频**必须**由一次真实的点击来"解锁"。
 *   本按钮承担两个职责：
 *     ① 用户主动开/关（并且这一次点击本身就是解锁手势）
 *     ② 显示当前状态
 *
 * ⚠️ 另外："开始占卜"按钮也会调用 unlockAmbience() ——
 *   所以用户其实**不需要**先点这个按钮才能在占卜中听到声音。
 *   这个按钮是给"我想先听听氛围"的用户的。
 *
 * ⚠️ 状态用 useSyncExternalStore 而不是 useState + useEffect：
 *   静音状态存在模块级单例里（跨组件共享），
 *   用 useEffect 去同步会触发 React 19 的 `set-state-in-effect` 规则
 *   —— 那不是"为了过 lint 而绕过"，而是真的多一次渲染。
 */
/**
 * ⚠️ "是否已在客户端"的判断
 *
 * 用 useSyncExternalStore 而不是 useState+useEffect：
 *   React 19 的 `react-hooks/set-state-in-effect` 规则会拒绝
 *   "挂载后 setState 一次"这种模式（它确实多一次渲染）。
 *   useSyncExternalStore 的 getSnapshot 在服务端返回 false、客户端返回 true，
 *   React 会**自动**在 hydration 后重渲染 —— 零额外渲染。
 */
const emptySubscribe = () => () => {};
const getFalse = () => false;
const getTrue = () => true;

export default function AmbienceToggle() {
  const muted = useSyncExternalStore(
    subscribeMuted,
    getMutedSnapshot,
    getMutedServerSnapshot
  );
  // ⚠️ 服务端 false / 客户端 true → hydration 后自动重渲染
  const isClient = useSyncExternalStore(emptySubscribe, getTrue, getFalse);

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

  if (!isClient) {
    // ⚠️ SSR/首帧不渲染按钮，避免 hydration 不一致
    return <div className="w-9 h-9" aria-hidden="true" />;
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={muted ? "开启占卜环境音" : "关闭占卜环境音"}
      title={muted ? "开启环境音" : "关闭环境音"}
      className="w-9 h-9 flex items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 hover:text-white/90 hover:bg-white/10 transition-colors"
    >
      {muted ? (
        // 静音图标
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          <path d="m22 9-6 6M16 9l6 6" />
        </svg>
      ) : (
        // 有声图标：声波
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </svg>
      )}
    </button>
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
