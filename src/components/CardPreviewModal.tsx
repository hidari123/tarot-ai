"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * 牌面放大预览（modal）
 *
 * ⚠️ 设计要点：**只看不翻** —— 点击已翻开的牌弹出大图查看，
 * 但没有"翻回去"的动作。用户点开牌的那一刻牌就永远朝上了，
 * 牌阵的明暗状态是占卜进度的表达，不该被查看行为改变。
 *
 * 与 CardSpread 顶部牌阵、DialogueFlow 对话流牌阵共用同一份状态，
 * 三处显示始终一致。
 */

export interface PreviewCard {
  nameZh: string;
  image: string;
  reversed: boolean;
  pos: string;
  /** 典籍牌意（若有，来自 card_reveal） */
  meaning?: string;
  /** 是否已解读完（决定角标） */
  done?: boolean;
}

export default function CardPreviewModal({ card, onClose }: {
  card: PreviewCard | null;
  onClose: () => void;
}) {
  /**
   * ⚠️ P2-⑮（第二轮优化分析 2026-11 ⑮）：模态框的**焦点管理**。
   *   原来：打开模态框后焦点仍在背景元素上 →
   *   ① 键盘用户 Tab 会跑到**背景里**（模态框没有焦点陷阱）
   *   ② 屏幕阅读器不知道这里弹出了一个对话框
   *   ③ Esc 关闭后焦点**不回到**原来的牌 → 键盘用户"丢失了位置"
   * ⚠️ 修法：打开时聚焦到模态框 → Tab 锁在框内 → 关闭时焦点还原。
   */
  const dialogRef = useRef<HTMLDivElement>(null);
  /** 打开前的焦点元素（关闭时还原） */
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Esc 关闭 + 焦点管理
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // ⚠️ 焦点陷阱：Tab 不能跑到模态框外面
      if (e.key === "Tab") {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // 背景滚动锁定
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // ⚠️ 记住打开前的焦点，关闭后还原
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    // 把焦点移进模态框
    const t = window.setTimeout(() => {
      const target = dialogRef.current?.querySelector<HTMLElement>("button");
      (target ?? dialogRef.current)?.focus();
    }, 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      window.clearTimeout(t);
      // ⚠️ 焦点还原到打开前的元素（键盘用户不丢位置）
      prevFocusRef.current?.focus?.();
    };
  }, [card, onClose]);

  return (
    <AnimatePresence>
      {card && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-6"
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={`${card.nameZh} 牌面预览`}
            tabIndex={-1}
            initial={{ scale: 0.88, y: 16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.92, y: 10, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.4, 0.1, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-sm outline-none"
          >
            {/* 大牌面 */}
            {/* ⚠️ aspect-ratio 内联兜底（防 dev 增量缓存不生成任意值类） */}
            <div style={{ aspectRatio: "2 / 3" }} className="relative w-full rounded-2xl overflow-hidden border border-purple-400/50 shadow-[0_0_60px_rgba(139,92,246,0.35)] bg-[#0d0716]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={card.image}
                alt={card.nameZh}
                className={`w-full h-full object-cover ${card.reversed ? "rotate-180" : ""}`}
              />
              {card.done && (
                <div className="absolute top-3 right-3 w-7 h-7 rounded-full bg-amber-400/90 flex items-center justify-center">
                  <span className="text-sm text-purple-950 font-bold">✓</span>
                </div>
              )}
            </div>

            {/* 牌名 + 位置 */}
            <div className="mt-3 text-center">
              <div
                className="text-lg text-purple-50 tracking-widest"
                style={{ fontFamily: "'Ma Shan Zheng', serif" }}
              >
                {card.nameZh}
                {card.reversed && <span className="text-xs text-purple-300/60 ml-2">逆位</span>}
              </div>
              <div className="mt-1">
                <span className="text-[10px] px-2 py-0.5 rounded-full border border-purple-400/40 text-purple-300/80 tracking-wider">
                  {card.pos}
                </span>
              </div>
            </div>

            {/* 典籍牌意 */}
            {card.meaning && (
              <p className="mt-3 text-xs text-sky-200/60 leading-relaxed border-l-2 border-sky-400/30 pl-2.5">
                {card.meaning}
              </p>
            )}

            <button
              onClick={onClose}
              className="mt-4 w-full py-2.5 rounded-xl border border-purple-500/40 text-purple-200 text-sm hover:bg-purple-900/30 transition-all"
            >
              关闭
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
