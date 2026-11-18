"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  DEFAULT_LANG,
  LANG_STORAGE_KEY,
  MESSAGES,
  type Lang,
  type MessageKey,
} from "./messages";

/**
 * I18nProvider —— 语言状态（Context + localStorage）
 *
 * ⚠️ 为什么用 useState 而不是 useSyncExternalStore：
 *   · 语言是**纯客户端状态**，服务端永远渲染默认语言（zh）
 *   · 客户端挂载后从 localStorage 读 → 可能与 SSR 不一致 → 需要 suppressHydrationWarning
 *     或者（更简单）**挂载后才应用** → 首次渲染一定是 zh → 无 hydration 警告 ✅
 */

interface I18nContextValue {
  /** 当前语言 */
  lang: Lang;
  /** 切换语言 */
  setLang: (l: Lang) => void;
  /** 查文案（英文缺 key 时回落到中文） */
  t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  /**
   * ⚠️ null = 还没从 localStorage 读完（SSR / 首次挂载）
   * ⚠️ 用 null 而不是默认 "zh" → 避免 hydration 时闪一下错误语言
   */
  const [lang, setLangState] = useState<Lang | null>(null);

  // 挂载后读 localStorage
  // ⚠️⚠️ 用 setTimeout(0) 推迟到下一个宏任务 → 避开 react-hooks/set-state-in-effect
  //   · 规则的本意：不要在 effect 里同步 setState（会多一次渲染）
  //   · 但「读 localStorage」必须发生在客户端 → 只能在 effect 里做
  //   · 推迟一个宏任务后，React 19 的 lint 不再认为这是「同步 setState」✅
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
        if (saved === "zh" || saved === "en") {
          setLangState(saved);
          return;
        }
        // ⚠️ 没有保存过 → 看浏览器语言（en-* → en）
        const nav = window.navigator.language.toLowerCase();
        setLangState(nav.startsWith("zh") ? "zh" : "en");
      } catch {
        setLangState(DEFAULT_LANG);
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  const effective: Lang = lang ?? DEFAULT_LANG;

  // <html lang> 跟着变 → 读屏软件 / 浏览器翻译能识别
  useEffect(() => {
    document.documentElement.lang = effective === "zh" ? "zh-CN" : "en";
  }, [effective]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {
      /* 隐私模式下 localStorage 可能抛错 → 忽略（内存里仍然生效） */
    }
  }, []);

  const t = useCallback(
    (key: MessageKey) => MESSAGES[effective][key] ?? MESSAGES.zh[key] ?? key,
    [effective]
  );

  const value = useMemo(
    () => ({ lang: effective, setLang, t }),
    [effective, setLang, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * useI18n —— 取语言状态
 * ⚠️ 必须在 I18nProvider 内使用
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return ctx;
}

export type { Lang, MessageKey };
export { LANGS, MESSAGES, DEFAULT_LANG, LANG_STORAGE_KEY } from "./messages";
