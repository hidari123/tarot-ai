"use client";

import { motion } from "framer-motion";

/**
 * 占卜师徽章（2026-11-06 视觉重设计 · 第 3 批）
 *
 * ⚠️⚠️ 为什么重做（用户反馈："颜色形状和图标都很丑"）：
 *   原版的问题（截图实测）：
 *     ① **五种色相的渐变球**（紫/绿/红/蓝/橙）→ 像 Windows 8 的开始菜单，
 *        完全没有"一个产品"的统一感。
 *     ② **1.5px 实心感的图标** + 68px 实心渐变圆底 → 又圆又实又闷，
 *        像"app 图标"而不像"占卜师"。
 *     ③ **符号是元素而非意象**（月/叶/剑/眼/焰）→ 全部退化成"属性标签"，
 *        失去人格（占卜师应该是**有性格的角色**，不是一个元素）。
 *     ④ **旋转光环**选中态 → 5 个图标各自在转，注意力被分散。
 *
 * ⚠️ 参考（竞品实测截图 2026-11-06）：
 *   Dear Arcana 的占卜师是**极细线条图标**（心/阴阳/太阳/星芒/月亮），
 *   选中态 = 深底 + 金环 + 金色图标，**完全静态**。
 *   → 我们照这个思路走，但保留深空紫的品牌底色。
 *
 * ⚠️ 三个关键决定：
 *   ① **统一底色**（不再五色）—— 品牌是紫+金
 *   ② **1px 极细金线**图标 —— 竞品验证过的"高级感"来源
 *   ③ **静态双环**选中（不做动效）—— 克制，且不给动画抢戏
 */

/**
 * 占卜师符号（1px 极细线条，24×24 视窗）
 *
 * ⚠️ 为什么用**意象**而不是元素：
 *   元素（月/火/剑）是"属性"，意象（星盘/羽毛/罗盘/手捧心/三叶草）是"角色"。
 *   → 意象能让五个占卜师各有故事，也更像塔罗传统里的形象。
 */
const PERSONA_SIGNS: string[] = [
  // ① 星盘（占卜师）—— 圆环 + 刻度 + 中心点 + 指针
  "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 7.5v4.5l3 2 M4.6 9.2l2 .9 M19.4 9.2l-2 .9 M6.5 17.4l1.6-1.4 M17.5 17.4l-1.6-1.4 M12 3.5v2 M12 18.5v2",
  // ② 手捧心（疗愈）—— 双手托起的轮廓 + 心
  "M12 20.5c-3.6-2.4-6.5-4.8-6.5-8a3.2 3.2 0 0 1 6.5-1 3.2 3.2 0 0 1 6.5 1c0 3.2-2.9 5.6-6.5 8Z M3.5 12.5c1.8 3.2 4.6 5 8.5 5s6.7-1.8 8.5-5",
  // ③ 羽毛笔（直觉）—— 羽轴 + 羽枝
  "M4.5 19.5 10 14 M8 16c-1.5-3.5 0-8 3.5-11.5 1 4 .5 8-3.5 11.5Z M9.5 14.5 13 11 M7.5 16.5 11 13",
  // ④ 罗盘（求道）—— 圆 + 十字 + 指针
  "M12 2.8a9.2 9.2 0 1 0 0 18.4 9.2 9.2 0 0 0 0-18.4Z M12 6.5v11 M6.5 12h11 M12 9.5 15 6.5 12 8 9 6.5Z",
  // ⑤ 三叶草（德鲁伊）—— 三叶 + 茎
  "M12 10.5c-2.2 0-3.6-1.4-3.6-3.1C8.4 5.7 10 4.6 12 4.6s3.6 1.1 3.6 2.8c0 1.7-1.4 3.1-3.6 3.1Z M8.8 9.4C6.6 9.4 5 7.9 5 6.1c0-1.5 1.3-2.5 3-2.5 1.9 0 3.4 1.3 3.4 3.1 0 1.5-1.1 2.7-2.6 2.7Z M15.2 9.4c2.2 0 3.8-1.5 3.8-3.3 0-1.6-1.3-2.5-3-2.5-1.9 0-3.4 1.3-3.4 3.1 0 1.5 1.1 2.7 2.6 2.7Z M12 10.5v9.5 M12 20c-1.5 0-2.5-1-2.5-2.2",
];

export interface PersonaOrbProps {
  id: string;
  name: string;
  /** 一句话描述 */
  tagline?: string;
  selected?: boolean;
  onClick?: () => void;
  /** 声明顺序（决定符号） */
  index?: number;
}

export default function PersonaOrb({
  id,
  name,
  tagline,
  selected = false,
  onClick,
  index = 0,
}: PersonaOrbProps) {
  const i = ((index % PERSONA_SIGNS.length) + PERSONA_SIGNS.length) % PERSONA_SIGNS.length;
  const path = PERSONA_SIGNS[i];
  // ⚠️ id 只用于 key/调试
  void id;

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ scale: 1.05, y: -3 }}
      whileTap={{ scale: 0.97 }}
      className="group flex flex-col items-center gap-2 outline-none"
      aria-pressed={selected}
      aria-label={`选择占卜师 ${name}`}
    >
      {/* 徽章 */}
      <div className="relative">
        {/* 选中态：静态双金环（不做旋转动效 —— 5 个图标一起转会分散注意力） */}
        {selected && (
          <>
            <span
              className="absolute -inset-[3px] rounded-full"
              style={{ border: "1px solid rgba(212,175,55,0.85)" }}
            />
            <span
              className="absolute -inset-[7px] rounded-full"
              style={{
                border: "1px solid rgba(212,175,55,0.30)",
                boxShadow: "0 0 20px rgba(212,175,55,0.28)",
              }}
            />
          </>
        )}

        <div
          className="relative w-[54px] h-[54px] rounded-full flex items-center justify-center transition-all duration-300"
          style={{
            /**
             * ⚠️ 统一底色（不再五色相）。
             * ⚠️ 为什么不是纯透明：徽章需要一个"底"才能承载细线图标
             *   （1px 的线在纯黑上会消失）。
             * → 深紫半透明 + 极淡的内部渐变（有体积但不发色）。
             */
            background: selected
              ? "radial-gradient(circle at 36% 30%, rgba(96,58,168,0.55), rgba(26,14,52,0.85))"
              : "radial-gradient(circle at 36% 30%, rgba(56,36,96,0.42), rgba(16,10,34,0.72))",
            border: selected
              ? "1px solid rgba(212,175,55,0.55)"
              : "1px solid rgba(168,85,247,0.22)",
            boxShadow: selected
              ? "0 0 22px rgba(212,175,55,0.30), inset 0 1px 0 rgba(255,255,255,0.08)"
              : "0 0 12px rgba(139,92,246,0.12), inset 0 1px 0 rgba(255,255,255,0.05)",
          }}
        >
          {/* 符号：1.3px 线条（比纯 1px 稍粗 —— 26px 的图标用 1px 在深底上会糊） */}
          <svg
            viewBox="0 0 24 24"
            width="30"
            height="30"
            fill="none"
            stroke={selected ? "rgba(240,217,138,0.95)" : "rgba(203,190,255,0.78)"}
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-colors duration-300"
          >
            <path d={path} />
          </svg>
        </div>
      </div>

      {/* 名字 */}
      <div
        className={`text-[12px] tracking-[0.12em] transition-colors ${
          selected ? "text-amber-100" : "text-purple-100/65 group-hover:text-purple-50"
        }`}
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        {name}
      </div>

      {/* 一句话描述（选中时才显示，避免首页太满） */}
      {tagline && (
        <div
          className={`text-[9.5px] text-purple-300/45 text-center leading-snug max-w-[112px] transition-opacity duration-300 ${
            selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          {tagline}
        </div>
      )}
    </motion.button>
  );
}
