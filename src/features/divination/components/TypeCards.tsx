"use client";

import { motion } from "framer-motion";

import {
  DIVINATION_TYPES,
  type DivinationType,
} from "@/features/divination/types/divination-types";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";

/**
 * TypeCards —— 首页下方的 8 张写实分类卡片
 *
 * ⚠️⚠️ 用户要求（原文）：
 *   「下面的卡片应该是一步：8 张写实卡片插画」
 *   「无字插画 + HTML 叠加文字；每张一个象征场景；3:4竖，
 *     并且里面文字内容需要稍微解释一下，方便用户理解」
 *   「图片风格跟目前的差不多，神秘写实异域风格」
 *
 * ⚠️⚠️ 为什么**文字用 HTML 叠加**而不是印在图上：
 *   · 印在图上 → 不可 i18n（中英切换会露出英文）
 *   · 印在图上 → 字体不可控、可能拼错字
 *   · 印在图上 → 移动端缩放后文字会糊
 *   → HTML 叠加：可 i18n、可响应式、可加动画 ✅
 *
 * ⚠️ 布局：**3:4 竖版**（用户指定）
 *   · 桌面 4 列 × 2 行
 *   · 移动 2 列 × 4 行（用户指定「每排两个」）
 */
export default function TypeCards({
  selected,
  onSelect,
}: {
  selected?: string | null;
  onSelect: (t: DivinationType) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="relative z-10 w-full max-w-4xl">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {DIVINATION_TYPES.map((ty, i) => {
          const active = selected === ty.id;
          return (
            <motion.button
              key={ty.id}
              type="button"
              onClick={() => onSelect(ty)}
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.55 }}
              whileHover={{ y: -6 }}
              whileTap={{ scale: 0.98 }}
              aria-pressed={active}
              className={`group relative overflow-hidden rounded-2xl border text-left transition-colors duration-300 ${
                active
                  ? "border-amber-300/70"
                  : "border-[rgba(212,175,55,0.22)] hover:border-[rgba(240,217,138,0.55)]"
              }`}
              style={{
                boxShadow:
                  "0 10px 34px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)",
              }}
            >
              {/* ---------- 插画（3:4）---------- */}
              <div className="relative aspect-[3/4] w-full overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/images/cards/${ty.id}.webp`}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.06]"
                />

                {/* 底部渐变（保证文字可读） */}
                <div
                  className="absolute inset-x-0 bottom-0 h-2/3"
                  style={{
                    background:
                      "linear-gradient(to top, rgba(6,3,16,0.96) 0%, rgba(6,3,16,0.82) 32%, rgba(6,3,16,0.35) 62%, rgba(6,3,16,0) 100%)",
                  }}
                />

                {/* 悬停时的金色边光 */}
                <span
                  className="absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100 pointer-events-none"
                  style={{
                    boxShadow:
                      "inset 0 0 34px rgba(212,175,55,0.28), inset 0 0 70px rgba(140,80,220,0.16)",
                  }}
                />

                {/* ---------- 文字（HTML 叠加）---------- */}
                <div className="absolute inset-x-0 bottom-0 p-3 sm:p-4">
                  {/* 主名 */}
                  <h3
                    className="mb-1 text-[15px] tracking-[0.2em] sm:text-[17px]"
                    style={{
                      fontFamily: "'Ma Shan Zheng', serif",
                      color: "#FFF4D6",
                      textShadow:
                        "0 2px 10px rgba(6,3,16,0.95), 0 0 22px rgba(212,175,55,0.35)",
                    }}
                  >
                    {t(`types.${ty.id}.zh` as MessageKey)}
                  </h3>

                  {/* 英文名（小字，异域感） */}
                  <p
                    className="mb-1.5 text-[9px] uppercase tracking-[0.24em] sm:text-[10px]"
                    style={{ color: "rgba(240,217,138,0.55)" }}
                  >
                    {t(`types.${ty.id}.en` as MessageKey)}
                  </p>

                  {/* 解释说明（用户要求「稍微解释一下，方便用户理解」） */}
                  <p
                    className="text-[10px] leading-relaxed sm:text-[11.5px]"
                    style={{ color: "rgba(226,216,255,0.78)" }}
                  >
                    {t(`types.${ty.id}.detail` as MessageKey)}
                  </p>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
