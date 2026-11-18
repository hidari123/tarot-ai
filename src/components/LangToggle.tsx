"use client";

import { useI18n, LANGS, type Lang } from "@/lib/i18n";

/**
 * LangToggle —— 中英切换（2026-11-18）
 *
 * ⚠️ 为什么用**双段按钮**而不是 <select>：
 *   · 只有两个选项 → 下拉是浪费一次点击
 *   · <select> 的原生下拉在深色主题里样式难控
 *   · 双段按钮：一眼看到两个选项 + 当前选中 ✅
 *
 * ⚠️ 样式：和配乐按钮同一套（紫色底 + 金边）→ 右上角视觉统一
 */
export default function LangToggle() {
  const { lang, setLang } = useI18n();

  return (
    <div
      className="flex items-center rounded-full border border-amber-300/40 bg-purple-950/60 p-0.5 backdrop-blur-sm"
      role="group"
      aria-label="Language"
    >
      {LANGS.map((l) => {
        const active = l.id === lang;
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => setLang(l.id as Lang)}
            aria-pressed={active}
            className={`rounded-full px-2.5 py-1 text-[11px] tracking-[0.1em] transition-colors ${
              active
                ? "bg-amber-300/90 text-purple-950 font-medium"
                : "text-purple-200/70 hover:text-purple-100"
            }`}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
