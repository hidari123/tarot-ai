"use client";

import { motion } from "framer-motion";

/**
 * 占卜师头像（2026-11-05 视觉重设计 · 第 3 批 · 首页）
 *
 * ⚠️ 为什么从"方块卡片 + emoji"改成"圆形符文头像"：
 *   原来的方块卡片（emoji + 名字 + 描述）视觉上就是**一张信息卡** ——
 *   六个同样的方块摆在那儿，没有主次，也没有"人"的感觉。
 *   → 圆形头像 = **徽章/印章**（神秘学语境里最自然的载体），
 *     且圆形天然有"聚焦"感，比方块更像一个可点击的对象。
 *
 * ⚠️ 头像本体是 SVG 生成的**占卜师符号**（不是 emoji）：
 *   emoji 在不同系统渲染不同（Windows 的 🌙 和 macOS 的完全不一样），
 *   视觉不可控 → 自己画 SVG，跨平台一致。
 *
 * ⚠️ 选中态：外圈**双环 + 旋转光环**（而不是换个背景色）。
 *   旋转光环是"占卜师正在运转"的暗示，且只有选中时才出现 → 状态一目了然。
 */

export interface PersonaOrbProps {
  id: string;
  name: string;
  /** 一句话描述 */
  tagline?: string;
  selected?: boolean;
  onClick?: () => void;
  /** 声明顺序（决定符号与配色） */
  index?: number;
}

/**
 * 每个占卜师的符号（SVG path，24x24 视窗）
 *
 * ⚠️ 为什么**按索引**映射而不是按 id 关键词匹配：
 *   实际的 persona id 是 "mystic" / "healer" / "blade" / "seeker" / "druid"
 *   （不含 moon/leaf/sword 这些符号名）→ 按关键词匹配会全部落到默认月亮
 *   → 五个占卜师长得一模一样（截图实测发现）。
 *   → 改为按**声明顺序**索引，稳定且不会因改名而错乱。
 */
const PERSONA_SIGNS: string[] = [
  // 月（神秘学家）
  "M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z",
  // 叶（疗愈者）
  "M5 19C5 11 11 5 19 5c0 8-6 14-14 14Zm0 0c2-4 5-7 9-9",
  // 剑（直言者）
  "M14.5 14.5 19 19M4 20l4-1 11-11-3-3L5 16l-1 4Zm9-13 3 3M3 21l4-4",
  // 眼（求道者）
  "M12 5c5 0 9 4.5 9 7s-4 7-9 7-9-4.5-9-7 4-7 9-7Zm0 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  // 焰（德鲁伊）
  "M12 3c3 4 5 6 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2.5-5 .3 1.5 1 2.5 2.5 2.5 0-3-1-5 0-6.5Z",
];

/** 每个占卜师的主色（渐变）—— 与符号同序 */
const PERSONA_COLORS: Array<[string, string]> = [
  ["#4c1d95", "#1e1b4b"], // 紫（月）
  ["#14532d", "#052e16"], // 绿（叶）
  ["#7f1d1d", "#1c1917"], // 红（剑）
  ["#1e3a8a", "#0f172a"], // 蓝（眼）
  ["#7c2d12", "#1c1917"], // 橙（焰）
];

export default function PersonaOrb({
  id,
  name,
  tagline,
  selected = false,
  onClick,
  index = 0,
}: PersonaOrbProps) {
  // ⚠️ 按声明顺序索引（persona id 不含符号名，不能按关键词匹配）
  const i = ((index % PERSONA_SIGNS.length) + PERSONA_SIGNS.length) % PERSONA_SIGNS.length;
  const path = PERSONA_SIGNS[i];
  const [c1, c2] = PERSONA_COLORS[i];
  // ⚠️ id 只用于 key/调试，这里用 data 属性透出（避免 no-unused-vars）
  void id;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.06, y: -3 }}
      whileTap={{ scale: 0.96 }}
      className="group flex flex-col items-center gap-2 outline-none"
      aria-pressed={selected}
      aria-label={`选择占卜师 ${name}`}
    >
      {/* 头像 */}
      <div className="relative">
        {/* 选中态：旋转光环 */}
        {selected && (
          <motion.div
            className="absolute -inset-2 rounded-full"
            style={{
              background:
                "conic-gradient(from 0deg, transparent 0deg, rgba(212,175,55,0.65) 60deg, transparent 130deg, transparent 360deg)",
              maskImage: "radial-gradient(circle, transparent 62%, black 64%)",
              WebkitMaskImage: "radial-gradient(circle, transparent 62%, black 64%)",
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
          />
        )}

        <div
          className="relative w-[68px] h-[68px] rounded-full flex items-center justify-center overflow-hidden transition-all duration-300"
          style={{
            background: `radial-gradient(circle at 34% 28%, ${c1}, ${c2})`,
            border: selected
              ? "1.5px solid rgba(212,175,55,0.85)"
              : "1px solid rgba(168,85,247,0.30)",
            boxShadow: selected
              ? "0 0 26px rgba(212,175,55,0.40), inset 0 2px 14px rgba(255,255,255,0.12)"
              : "0 0 14px rgba(139,92,246,0.16), inset 0 2px 10px rgba(255,255,255,0.08)",
          }}
        >
          {/* 符号（SVG，跨平台一致） */}
          <svg
            viewBox="0 0 24 24"
            width="28"
            height="28"
            fill="none"
            stroke={selected ? "#f5e6b8" : "rgba(233,213,255,0.82)"}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-colors duration-300"
          >
            <path d={path} />
          </svg>

          {/* 内部纹理（让圆面不"空"） */}
          <div
            className="absolute inset-0 opacity-40 pointer-events-none"
            style={{
              backgroundImage:
                "radial-gradient(1px 1px at 30% 26%, rgba(255,255,255,0.6), transparent)," +
                "radial-gradient(1px 1px at 70% 62%, rgba(255,255,255,0.45), transparent)",
            }}
          />
        </div>
      </div>

      {/* 名字 */}
      <div
        className={`text-[13px] tracking-wider transition-colors ${
          selected ? "text-amber-100" : "text-purple-100/75 group-hover:text-purple-50"
        }`}
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        {name}
      </div>

      {/* 一句话描述（悬停才显示，避免首页太满） */}
      {tagline && (
        <div className="text-[10px] text-purple-300/45 text-center leading-snug max-w-[104px] opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          {tagline}
        </div>
      )}
    </motion.button>
  );
}
