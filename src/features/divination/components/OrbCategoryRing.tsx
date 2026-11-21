"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";

import {
  DIVINATION_TYPES,
  type DivinationType,
} from "@/features/divination/types/divination-types";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";

/**
 * OrbCategoryRing —— 水晶球一圈的「图标 + 名称」环形排布
 *
 * ⚠️⚠️ 用户要求（原文）：
 *   「这些icon是应该排布到水晶球这一圈的 icon+名称」
 *   「小女孩这两侧可以展示精简的图标 周围高亮一点 金色的发光效果
 *     一边4个透明底图标+文字名称 hover的时候会稍稍变大」
 *   「移动端不要悬浮在两侧的 可以悬浮在小女孩身上成为一个圆圈」
 *
 * ⚠️⚠️ 定位方式：**absolute + CSS 变量**
 *   · 球在 WitchOrb 里是 `absolute`（跟着页面滚动，用户明确要这个）
 *   · 球心由 WitchOrb 算出并写入 CSS 变量：
 *     `--orb-ball-cx` / `--orb-ball-cy`（相对视口）/ `--orb-ball-d`（球直径）
 *   · 环形组件用同样的坐标系 → **天然对齐**，不用维护两份坐标 ✅
 *   ⚠️ 为什么不用 fixed：球会滚走，fixed 会脱节 ❌
 *
 * ⚠️ 半径：以**球直径**为基准（用户要求「一圈」）
 *   · 桌面端：球径 × 1.15（稍大一点，在两侧悬浮）
 *   · 移动端：球径 × 0.62（贴在女孩身上成圈）
 */
export default function OrbCategoryRing({
  selected,
  onSelect,
}: {
  selected?: string | null;
  onSelect: (t: DivinationType) => void;
}) {
  const { t } = useI18n();

  /** 窄屏（移动端）→ 弧线收窄 */
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-20" aria-label="占卜分类">
      {DIVINATION_TYPES.map((ty, i) => {
        /**
         * ⚠️⚠️ 参数角（椭圆参数方程）→ 沿椭圆等距 + 左右严格镜像 ✅
         *   · 之前用**几何角** + 椭圆半径（rx≠ry）→ 上下半圈角速度不均
         *     → 视觉上左右不对称 ❌
         *
         * ⚠️⚠️ 端点直接写死（两套）：
         *   · 桌面（narrow=false）：左侧 225°→90°，右侧 315°→90°(=450°)
         *     → 总跨度 270°，上下各留 90°（正上方标题、正下方球）✅
         *   · 移动（narrow=true）：左侧 275°→180°，右侧 85°→-10°(=350°)
         *     → 窄屏（420px）上 8 个图标才不会挤成一团 ✅
         */
        const [leftEnd, leftStart, rightStart, rightEnd] = narrow
          ? [262, 172, 88, -2]
          : [225, 90, 315, 90];
        const ang =
          (i < 4
            ? leftEnd - (i * (leftEnd - leftStart)) / 3
            : rightStart + ((i - 4) * (rightEnd - rightStart)) / 3) *
          (Math.PI / 180);
        const active = selected === ty.id;

        return (
          <motion.button
            key={ty.id}
            type="button"
            onClick={() => onSelect(ty)}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.55 + i * 0.05, duration: 0.5 }}
            whileHover={{ scale: 1.15 }}
            whileTap={{ scale: 0.94 }}
            aria-pressed={active}
            className="pointer-events-auto group absolute flex flex-col items-center gap-1 outline-none"
            style={{
              /**
               * ⚠️ 圆心 = 球心（CSS 变量，来自 WitchOrb）
               * ⚠️⚠️ 变量是**百分比**（相对 main）→ 和本组件所在的
               *   `absolute inset-0` 层同一坐标系 → 天然对齐 ✅
               */
              left: `calc(var(--orb-ring-cx, 50%) + ${Math.cos(ang)} * var(--ring-r, 268px))`,
              top: `calc(var(--ring-cy, 250px) + ${Math.sin(ang)} * var(--ring-ry, 158px))`,
              transform: "translate(-50%, -50%)",
            }}
          >
            {/* 图标（透明底 + 金色发光） */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ty.icon}
              alt=""
              className="h-9 w-9 object-contain transition-transform duration-300 group-hover:scale-125"
              style={{
                filter:
                  "drop-shadow(0 0 6px rgba(240,217,138,0.9)) drop-shadow(0 0 16px rgba(212,175,55,0.6)) drop-shadow(0 0 30px rgba(140,80,220,0.4))",
              }}
            />
            {/* 名称 */}
            <span
              className="whitespace-nowrap text-[11px] tracking-[0.14em] transition-all duration-300 group-hover:scale-110"
              style={{
                color: active ? "rgba(255,244,214,1)" : "rgba(240,217,138,0.85)",
                transform: active ? "scale(1.2)" : "scale(1)",
                transformOrigin: "center bottom",
                textShadow:
                  "0 1px 8px rgba(8,4,20,0.95), 0 0 18px rgba(8,4,20,0.9), 0 0 30px rgba(212,175,55,0.4)",
              }}
            >
              {t(`types.${ty.id}.zh` as MessageKey)}
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
