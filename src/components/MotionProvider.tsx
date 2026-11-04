"use client";

import { MotionConfig, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * 动效降级（配合 globals.css 的 prefers-reduced-motion 媒体查询）
 *
 * ⚠️ P2-⑳（第二轮优化分析 2026-11 ⑳）：CSS 媒体查询只能管**CSS 动画**，
 *   而本项目大量的动效是 framer-motion 的 **JS 动画**（卡片入场、面板展开、
 *   思考气泡呼吸…）—— 它们不受 CSS 媒体查询影响。
 * ⚠️ `MotionConfig reducedMotion="user"` 让 framer-motion 自动：
 *   · 关闭 transform 类型的动画（位移/缩放/旋转）
 *   · 保留 opacity 类型的动画（淡入淡出是安全的，不会引起前庭不适）
 * ⚠️ 官方推荐做法 —— 不用逐个组件改。
 */
export default function MotionProvider({ children }: { children: ReactNode }) {
  // ⚠️ useReducedMotion 跟随系统设置；MotionConfig 的 reducedMotion="user"
  //   会读取它 → 一处配置，全站生效。
  const reduced = useReducedMotion();
  return (
    <MotionConfig reducedMotion={reduced ? "always" : "user"}>
      {children}
    </MotionConfig>
  );
}
