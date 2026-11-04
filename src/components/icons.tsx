"use client";

/**
 * 图标集 —— 塔罗主题的**线条 SVG 图标**
 *
 * ⚠️⚠️ 为什么不用 emoji（用户诉求："目前图标都是emoji，想要更漂亮一点的图标"）：
 *   ① **跨平台不一致**：emoji 由系统字体渲染 ——
 *      Windows 是 Segoe UI Emoji（彩色方块），macOS 是 Apple Color Emoji，
 *      Android 是 Noto Color Emoji → 同一个 🃏 在三台机器上长得完全不一样。
 *      而且很多 emoji 在 Linux 服务器上会**渲染成豆腐块**（□）。
 *   ② **风格不搭**：emoji 是圆润的彩色贴纸风，
 *      而本项目是"暗紫 + 金线 + 魔法阵"的古典神秘风 → 违和。
 *   ③ **不可控**：大小/基线/颜色随字体变化，无法精确对齐。
 *
 *   → SVG 图标：**任何设备上完全一致**、随 currentColor 变色、
 *     线条粗细可控、与整体的紫金配色统一。
 *
 * ⚠️ 设计约定：
 *   · 全部用 **stroke**（线性），不填色 → 轻盈、不抢戏
 *   · viewBox 统一 24×24，strokeWidth 1.6（在 16~20px 下清晰）
 *   · 圆角端点（strokeLinecap="round"）→ 柔和，符合"神秘"调性
 *   · 图标本身**不设颜色**（继承 currentColor），由调用方用 className 决定
 */

export type IconName =
  | "crystal"      // 水晶球（凝听问题）
  | "cards"        // 牌（命运之牌）
  | "book"         // 书（翻阅典籍）
  | "thought"      // 思考泡（等待回应 / 澄清）
  | "eye"          // 眼（审校检视）
  | "sparkle"      // 星芒（解读完成）
  | "candle"       // 烛（翻牌闸门）
  | "scry"         // 水晶球+星（命运岔路）
  | "scroll"       // 卷轴（典籍忠实 / 命运之卷）
  | "heart"        // 心（共情回应）
  | "masks"        // 面具（语气人格 / 编排者）
  | "magnify"      // 放大镜（检索）
  | "quill"        // 羽毛笔（撰写者）
  | "wand"         // 魔杖（工具）
  | "moon"         // 月（占卜师）
  | "orbit";       // 轨道（岔路）

/** 图标路径表（24×24 viewBox） */
const PATHS: Record<IconName, React.ReactNode> = {
  /* 水晶球：圆 + 内部反光 + 底座 */
  crystal: (
    <>
      <circle cx="12" cy="10" r="6" />
      <path d="M9.5 8.5a3 3 0 0 1 2-1.6" />
      <path d="M9 16.5h6M10 19.5h4M11.5 16.5v3" />
    </>
  ),
  /* 牌：两张错开的矩形 */
  cards: (
    <>
      <rect x="7" y="4" width="10" height="14" rx="1.6" transform="rotate(-8 12 11)" />
      <rect x="8.5" y="6" width="10" height="14" rx="1.6" transform="rotate(6 13.5 13)" />
    </>
  ),
  /* 书：翻开的两页 */
  book: (
    <>
      <path d="M12 6.5C10.5 5 8 4.5 4.5 5v12C8 16.5 10.5 17 12 18.5" />
      <path d="M12 6.5C13.5 5 16 4.5 19.5 5v12C16 16.5 13.5 17 12 18.5" />
      <path d="M12 6.5v12" />
    </>
  ),
  /* 思考泡 */
  thought: (
    <>
      <path d="M15.5 5.5a6.5 6.5 0 1 0 0 13H9l-3.5 3v-4.2a6.5 6.5 0 0 1 10-11.8Z" />
      <path d="M9.5 10h.01M12 10h.01M14.5 10h.01" />
    </>
  ),
  /* 眼：审校 */
  eye: (
    <>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  /* 星芒 */
  sparkle: (
    <>
      <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3Z" />
      <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
    </>
  ),
  /* 烛 */
  candle: (
    <>
      <path d="M12 3.5c1.4 1.6 2 2.8 2 4a2 2 0 1 1-4 0c0-1.2.6-2.4 2-4Z" />
      <path d="M9.5 10.5h5v9h-5z" />
      <path d="M8 20.5h8" />
    </>
  ),
  /* 水晶球 + 星（岔路） */
  scry: (
    <>
      <circle cx="12" cy="9.5" r="5.5" />
      <path d="M12 6.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
      <path d="M9 16h6M10.5 18.5h3M12 16v2.5" />
    </>
  ),
  /* 卷轴 */
  scroll: (
    <>
      <path d="M6 4.5h11a2 2 0 0 1 0 4H8a2 2 0 0 0 0 4h10" />
      <path d="M6 4.5v13a2 2 0 0 0 2 2h10" />
      <path d="M9 9.5h6" />
    </>
  ),
  /* 心 */
  heart: (
    <path d="M12 20s-7-4.4-7-9.4A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.6c0 5-7 9.4-7 9.4Z" />
  ),
  /* 面具 */
  masks: (
    <>
      <path d="M4 6.5h16v4c0 4.2-3.6 7.5-8 8-4.4-.5-8-3.8-8-8v-4Z" />
      <path d="M8.5 11c.8.7 1.7.7 2.5 0M13 11c.8.7 1.7.7 2.5 0" />
    </>
  ),
  /* 放大镜 */
  magnify: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
    </>
  ),
  /* 羽毛笔 */
  quill: (
    <>
      <path d="M4.5 19.5 15 9" />
      <path d="M9 15c-1.5-4 1-8.5 6.5-11 1 6-1 10.5-4.5 11.5" />
      <path d="M9 15c2.5 1 4.5.5 6-1" />
    </>
  ),
  /* 魔杖 */
  wand: (
    <>
      <path d="M5 19 15.5 8.5" />
      <path d="M17 4l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9Z" />
      <path d="M7 6l.5 1.5L9 8l-1.5.5L7 10l-.5-1.5L5 8l1.5-.5L7 6Z" />
    </>
  ),
  /* 月 */
  moon: (
    <>
      <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" />
      <path d="M16.5 4.5l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5.5-1.4Z" />
    </>
  ),
  /* 轨道 */
  orbit: (
    <>
      <circle cx="12" cy="12" r="2.4" />
      <ellipse cx="12" cy="12" rx="9" ry="4.2" transform="rotate(-28 12 12)" />
    </>
  ),
};

/**
 * 图标组件
 *
 * @param name 图标名
 * @param size 像素尺寸（默认 18）
 * @param className 额外类名（**用来定颜色** —— 图标继承 currentColor）
 */
export default function Icon({
  name,
  size = 18,
  className = "",
  strokeWidth = 1.6,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
