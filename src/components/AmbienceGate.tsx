"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { unlockAmbience, setMuted, setAmbienceLayer, isMuted } from "@/lib/audio/ambient";

/**
 * 首页入场：点击开启占卜之声
 *
 * ⚠️⚠️ 为什么需要它（用户诉求："首页一进去就要有音乐"）：
 *   浏览器**禁止无用户手势的音频自动播放**（Chrome/Safari 都拦）——
 *   这不是可以绕过的限制，而是浏览器的隐私/流量保护策略。
 *   所以"一进去就响"在技术上**不可能**，除非：
 *     ① 用户先做过一次手势（点击）→ 之后就可以自动播放
 *     ② 用一个极短的静音播放尝试解锁 → 成功率低且行为不统一
 *
 *   → 选 ①：**把"解锁"包装成一个仪式**。
 *     这个提示不是丑陋的遮罩，而是一句安静的邀请：
 *     "轻触任意处，开启占卜之声"。
 *     用户点击 → 解锁 → 立刻有音乐（不是几秒后）→ 提示淡出。
 *
 * ⚠️ 为什么不是按钮：
 *   按钮会让人以为"不点就没有"，而实际是"点了才能开始"。
 *   "轻触任意处"更像**入场**，与占卜的调性一致。
 *
 * ⚠️ 关键：**点击任意处**都能解锁 → 监听在 window 上（capture 阶段），
 *   而不是只在提示文字上。
 */
export default function AmbienceGate() {
  const [dismissed, setDismissed] = useState(false);
  const [visible, setVisible] = useState(false);

  /**
   * ⚠️ 延迟一点再显示（400ms）
   *   理由：页面刚加载时显示一个大提示会挡住内容，用户还没看清这是什么。
   *   400ms 后页面已经稳定，提示出现时用户刚好准备开始操作。
   *
   * ⚠️ 为什么用 setTimeout 而不是直接 setState：
   *   React 19 的 `react-hooks/set-state-in-effect` 规则拒绝在 effect 里同步 setState。
   *   setTimeout 回调里 setState 是允许的（那才是正常的数据流方向）。
   */
  useEffect(() => {
    // ⚠️ 已经解锁过（用户之前点过）→ 不再提示
    if (isMuted() === false) {
      setTimeout(() => setDismissed(true), 0);
      return;
    }
    const t = setTimeout(() => setVisible(true), 400);
    return () => clearTimeout(t);
  }, []);

  const onFirstGesture = useCallback(async () => {
    if (dismissed) return;
    setDismissed(true);
    setVisible(false);
    try {
      // ⚠️ 必须在**用户手势的同步上下文**里解锁 → AudioContext.resume() 才成功
      await unlockAmbience();
      setMuted(false);
      // ⚠️ 首页的默认层是 idle —— ⚠️ 关键：idle 现在**有旋律**
      //    （第一版 idle 是几乎无声的底噪，所以用户听不到东西）
      setAmbienceLayer("idle");
    } catch {
      // 解锁失败（用户拒绝/浏览器策略）→ 静默，用户仍可点右上角开关
    }
  }, [dismissed]);

  // ⚠️ 监听 window 的第一次指针/键盘事件（capture 阶段 → 先于页面其他逻辑）
  useEffect(() => {
    if (dismissed) return;
    const handler = () => { void onFirstGesture(); };
    window.addEventListener("pointerdown", handler, { capture: true, once: true });
    window.addEventListener("keydown", handler, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", handler, { capture: true });
      window.removeEventListener("keydown", handler, { capture: true });
    };
  }, [dismissed, onFirstGesture]);

  return (
    <AnimatePresence>
      {visible && !dismissed && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.5 }}
          className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
        >
          {/**
           * ⚠️ pointer-events-none + 上面 window 级别的监听：
           *   提示本身不拦截点击（用户点页面任何地方都能解锁），
           *   但它仍然可见 → 用户知道"可以点"。
           */}
          <div className="flex flex-col items-center gap-4 px-6 text-center">
            <motion.div
              animate={{ scale: [1, 1.08, 1], opacity: [0.55, 0.9, 0.55] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
              className="w-16 h-16 rounded-full border border-purple-400/40 flex items-center justify-center bg-purple-950/30 backdrop-blur-sm"
            >
              <span className="text-2xl text-purple-200/90">✧</span>
            </motion.div>
            <p
              className="text-sm tracking-[0.25em] text-purple-200/70"
              style={{ fontFamily: "'Ma Shan Zheng', serif" }}
            >
              轻触任意处，开启占卜之声
            </p>
            <p className="text-[11px] text-purple-300/35">
              浏览器要求由你亲手开启声音
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
