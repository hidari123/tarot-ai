"use client";

import { motion, AnimatePresence } from "framer-motion";

import PersonaOrb from "@/components/PersonaOrb";
import { PERSONAS } from "@/lib/personas";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";

/**
 * PersonaPicker —— 第二级：选占卜师（2026-11-18 · MOIRA 首页重排）
 *
 * ⚠️⚠️ 为什么是**第二级**且**可跳过**：
 *   · 5 个占卜师的区别是「**说话风格**」，不是「**问什么**」
 *   · 用户在第一级已经说了"我要问什么" → 第二级才是"你想听谁说"
 *   · 放在第一级 → 用户会以为必须理解 5 个风格才能开始（调研 P0-4 的原话）
 *   → 折叠、可跳过、默认按分类推荐一个 ✅
 *
 * ⚠️ 为什么保留「让 MOIRA 替我选」：
 *   · 占卜是**仪式** —— 用户想要的是"被指引"的感觉，不一定要自己挑
 *   · 给一条零门槛的出路（调研 P1-6 的思路）✅
 */
export default function PersonaPicker({
  selected,
  onSelect,
  onSkip,
  /** 该分类的推荐占卜师（默认选中的高亮） */
  recommended,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
  onSkip: () => void;
  recommended?: string;
}) {
  const { t } = useI18n();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.4 }}
      className="relative z-10 w-full max-w-2xl"
    >
      {/* 标题 + 跳过 */}
      <div className="mb-3 flex items-baseline justify-center gap-3">
        <p className="text-[11px] tracking-[0.34em] text-purple-300/45">
          {t("home.choosePersona")}
        </p>
        <button
          type="button"
          onClick={onSkip}
          className="text-[10px] tracking-[0.12em] text-purple-300/40 underline underline-offset-4 transition-colors hover:text-purple-200/80"
        >
          {t("home.skipPersona")}
        </button>
      </div>

      {/* 提示 */}
      <p className="mb-4 text-center text-[10px] tracking-[0.1em] text-purple-300/30">
        {t("home.choosePersonaHint")}
      </p>

      {/* 占卜师 */}
      <div className="flex items-start justify-center gap-3 sm:gap-5">
        {PERSONAS.map((p, i) => (
          <PersonaOrb
            key={p.id}
            id={p.id}
            index={i}
            name={t(`persona.${p.id}.name` as MessageKey)}
            tagline={t(`persona.${p.id}.tag` as MessageKey)}
            selected={selected === p.id}
            onClick={() => onSelect(p.id)}
          />
        ))}
      </div>

      {/* ⚠️ 推荐提示：说明「为什么默认选中这个」 */}
      {recommended && (
        <p className="mt-3 text-center text-[10px] tracking-[0.08em] text-purple-300/30">
          {t("home.choosePersonaHint")}
        </p>
      )}
    </motion.div>
  );
}

/**
 * AnimatePresence 包装版（用于展开/收起动画）
 */
export function PersonaPickerAnimated(props: React.ComponentProps<typeof PersonaPicker>) {
  return (
    <AnimatePresence>
      {props.selected !== undefined && <PersonaPicker {...props} />}
    </AnimatePresence>
  );
}
