"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import PersonaOrb from "@/components/PersonaOrb";
import { PERSONAS } from "@/lib/personas";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";

/**
 * PersonaStyleSwitch —— 导师风格切换（第二页顶栏 · 2026-11-19）
 *
 * ⚠️⚠️ 用户要求（原文）：
 *   「可以选择导师风格 默认会有一个风格 可以自己切换」
 *
 * ⚠️⚠️ 为什么用 **PERSONAS 常量**而不是接口数据：
 *   · 接口 `/api/personas` 的数据在 TarotApp 的 state 里
 *   · 但这个切换器是**独立组件** → 拿不到那个 state
 *   · 而 PERSONAS 是同一份静态定义（id/name/desc 一致）
 *   · → 切换后需要同步回 TarotApp 的 persona state
 *   ⚠️ 解法：用 **CustomEvent** 通知父组件（跨组件通信的轻量做法）
 *   · 事件名固定，父组件监听一次 → 同步 persona ✅
 *
 * ⚠️ 默认值：父组件（TarotApp）按分类推荐并设好 → 按钮上直接显示当前导师
 */
const EVENT = "moira:persona-change";

export default function PersonaStyleSwitch() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // ⚠️ 本地镜像（用于按钮上显示当前选中的导师）
  const [current, setCurrent] = useState<string | null>(null);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-[rgba(212,175,55,0.28)] bg-[rgba(9,5,20,0.66)] backdrop-blur-md px-3 py-1.5 text-[12px] tracking-[0.1em] text-[rgba(255,248,235,0.85)] transition-all hover:border-[rgba(240,217,138,0.6)]"
      >
        <span aria-hidden>✦</span>
        <span className="hidden sm:inline">{current ?? "导师"}</span>
        <span className="text-[9px] opacity-60">切换</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.2 }}
            className="absolute right-0 top-full mt-2 z-40 rounded-2xl border border-[rgba(212,175,55,0.28)] bg-[rgba(9,5,20,0.94)] backdrop-blur-xl p-3 shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
          >
            <p className="mb-2 px-1 text-[10px] tracking-[0.2em] text-purple-300/50">
              {t("persona.chooseStyle")}
            </p>
            <div className="flex gap-2">
              {PERSONAS.map((p, i) => (
                <PersonaOrb
                  key={p.id}
                  id={p.id}
                  index={i}
                  name={t(`persona.${p.id}.name` as MessageKey)}
                  tagline={t(`persona.${p.id}.tag` as MessageKey)}
                  selected={current === p.id}
                  onClick={() => {
                    setCurrent(p.id);
                    setOpen(false);
                    // ⚠️ 通知父组件同步 persona state
                    window.dispatchEvent(
                      new CustomEvent(EVENT, { detail: { id: p.id } })
                    );
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** ⚠️ 供父组件监听的事件名 */
export const PERSONA_EVENT = EVENT;
