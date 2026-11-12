"use client";

import { useEffect } from "react";

/**
 * ViewportScale —— 全局等比缩放系数 `--u`
 *
 * ⚠️⚠️⚠️ 为什么需要（用户反馈「不同页面大小下 文字和图片比例不一致」）
 *
 * ⚠️ 问题的本质：
 *   · 文字用**固定 px**（`text-6xl` = 60px、`pt-12` = 48px…）
 *   · 图片用**比例单位**（`112vw`、`-17.5vh`）
 *   → 窗口尺寸变化时，两者按**不同速率**移动
 *   → 球的相对位置必然漂移（小屏上移、大屏下移）
 *
 * ⚠️ 解法：**让所有东西共用一个缩放系数**
 *   u = min(vw / 1200, vh / 900)      ← 1200×900 是设计基准
 *   → 文字、间距、图片、占位块**全部**乘 u
 *   → 任何尺寸下构图比例完全一致 ✅
 *
 * ⚠️⚠️ 为什么缩放系数必须用 **JS** 算（不能纯 CSS）：
 *   CSS 的 calc() **不支持单位相除**（`calc(100vw / 1200)` 非法）
 *   → 只能用 JS 算出 u，写进 `--u`，CSS 侧用 `calc(基准值 * var(--u))` 消费
 *
 * ⚠️⚠️ 为什么不用「按宽度」或「按高度」单独算：
 *   · 只按宽度：竖屏（375×800）时 u 很小 → 文字小到看不清
 *   · 只按高度：宽扁屏（2560×800）时 u 很小 → 文字小到看不清
 *   → 取 min（等比缩放，不裁切）→ 任何形状都能完整显示 ✅
 *
 * ⚠️ 移动端另做：
 *   `@media (max-width: 768px)` 时 `--u` 固定为 1（不做等比缩放）
 *   → 手机上用正常字号 + 单独的布局（见 globals.css）
 *
 * ⚠️ 为什么这个组件放在 layout（而不是 page）：
 *   · 它写的是 `document.documentElement` 的 CSS 变量 → 全局生效
 *   · 放 layout → 所有页面都能用 ✅
 */
export default function ViewportScale() {
  useEffect(() => {
    const root = document.documentElement;

    const update = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      /**
       * ⚠️ 移动端判定用 **CSS 媒体查询**（不用 JS）
       *   · 项目已有大量 `md:` 断点（768px）→ 保持一致
       *   · 纯 CSS → 无 hydration 闪烁、无首帧错位
       *   → JS 只负责算 u，移动端分支交给 CSS 覆盖 --u
       */
      const isMobile = window.matchMedia("(max-width: 768px)").matches;

      if (isMobile) {
        // 移动端：不做等比缩放（CSS 里也会覆盖 --u，这里保持一致）
        root.style.setProperty("--u", "1");
        return;
      }

      /** 等比缩放系数（不裁切 → 取 min） */
      const u = Math.min(vw / 1200, vh / 900);
      /**
       * ⚠️ 夹住范围（避免极端尺寸下文字过大/过小）
       *   · 下限 0.8 → 1024×640 以下不再缩小（文字仍可读）
       *   · 上限 1.4 → 1920 屏封顶（标题不会变成 84px 那么夸张）
       */
      const clamped = Math.max(0.8, Math.min(u, 1.4));
      root.style.setProperty("--u", clamped.toFixed(4));
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return null;
}
