"use client";

import { motion } from "framer-motion";

import {
  DIVINATION_TYPES,
  type DivinationType,
} from "@/features/divination/types/divination-types";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";

/**
 * TypeGrid —— 占卜分类网格（2026-11-18 · MOIRA 首页重排 · 第一级）
 *
 * ⚠️⚠️ 为什么这是**第一级**：
 *   用户的心智是「我想问什么」，不是「用谁来说」
 *   → 8 个主题排在前面，占卜师退到第二级（可跳过）
 *
 * ⚠️ 布局：**4 列网格**（不是弧形）
 *   · 弧形（tarotoo 的做法）视觉更灵动，但：
 *     · 文字标签在弧线上排布会让每项的基线不一致 → 看着乱
 *     · 移动端没法做（横向滚动 + 弧线 = 两条轴的复杂度）
 *     · 8 个项目在 4 列网格里刚好 2 行 → 高度可控 ✅
 *   → 弧形留给**纯图标**的装饰性排列，文字标签用网格 ✅
 *
 * ⚠️ 卡片视觉：**图标为主，文字为辅**
 *   · 图标 100% 不透明的线稿金色 → 视觉焦点
 *   · 主名（唯美两字）→ 14px
 *   · 副标题（白话）→ 10px，低透明度
 *   · 悬停：图标放大 + 卡片边框发光 + 轻微上浮
 */
export default function TypeGrid({
  selected,
  onSelect,
}: {
  /** 当前选中的分类 id */
  selected?: string | null;
  /** 选中回调（第二级由父组件控制展开） */
  onSelect: (t: DivinationType) => void;
}) {
  const { t } = useI18n();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.18, duration: 0.6 }}
      className="relative z-10 w-full max-w-3xl"
    >
      {/* 分组标题 */}
      <p className="mb-3 text-center text-[11px] tracking-[0.34em] text-purple-300/45">
        {t("home.chooseType")}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {DIVINATION_TYPES.map((ty, i) => {
          const active = selected === ty.id;
          return (
            <motion.button
              key={ty.id}
              type="button"
              onClick={() => onSelect(ty)}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.24 + i * 0.04, duration: 0.45 }}
              whileHover={{ y: -3 }}
              whileTap={{ scale: 0.97 }}
              aria-pressed={active}
              className={`group relative flex flex-col items-center gap-1.5 rounded-2xl border px-2 py-4 transition-colors duration-300 ${
                active
                  ? "border-amber-300/55 bg-[rgba(60,32,110,0.55)]"
                  : "border-[rgba(212,175,55,0.20)] bg-[rgba(9,5,20,0.62)] hover:border-[rgba(240,217,138,0.48)]"
              }`}
              style={{
                boxShadow:
                  "0 6px 22px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.05)",
              }}
            >
              {/* 悬停时的金色边光 */}
              {!active && (
                <span
                  className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                  style={{
                    boxShadow:
                      "0 0 26px rgba(212,175,55,0.26), inset 0 0 16px rgba(212,175,55,0.07)",
                  }}
                />
              )}

              {/* 图标（视觉焦点） */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={ty.icon}
                alt=""
                className="relative h-11 w-11 object-contain transition-transform duration-300 group-hover:scale-110"
                style={{
                  filter:
                    "drop-shadow(0 0 7px rgba(240,217,138,0.50)) drop-shadow(0 0 16px rgba(212,175,55,0.22))",
                }}
              />

              {/* 主名 */}
              <span className="relative text-[15px] tracking-[0.16em] text-[rgba(255,248,235,0.94)]">
                {t(`types.${ty.id}.zh` as MessageKey)}
              </span>

              {/* 副标题（白话说明） */}
              <span className="relative text-[10px] leading-tight text-[rgba(203,190,255,0.52)] text-center px-1">
                {t(`types.${ty.id}.desc` as MessageKey)}
              </span>
            </motion.button>
          );
        })}
      </div>
    </motion.div>
  );
}
