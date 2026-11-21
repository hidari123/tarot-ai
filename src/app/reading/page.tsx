"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import TarotApp from "@/features/divination/components/TarotApp";
import { getType } from "@/features/divination/types/divination-types";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";

/**
 * ReadingPage —— 第二页：对话页（2026-11-19）
 *
 * ⚠️⚠️ 用户要求（原文）：
 *   「在点击卡片之后跳转到第二页 页面上展示对话框
 *     可以选择导师风格 默认会有一个风格 可以自己切换」
 *
 * ⚠️⚠️ 为什么用**独立路由**（/reading）而不是单页状态切换：
 *   · 可分享链接（用户能把「月引」的占卜发给朋友）
 *   · 刷新不丢状态（分类在 URL query 里）
 *   · 首页 = 展示，第二页 = 工作 → 职责清晰 ✅
 *
 * ⚠️ 占卜逻辑全部复用 TarotApp（和首页同一套）→ 不会漂移
 */
function ReadingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();

  const typeId = params.get("type");
  const type = getType(typeId);

  return (
    <>
      {/* ---------- 第二页顶栏：返回 + 分类 + 导师风格切换 ---------- */}
      <ReadingHeader
        title={type ? t(`types.${type.id}.zh` as MessageKey) : ""}
        onBack={() => router.push("/")}
      />

      {/* ---------- 占卜主体（和首页同一套逻辑）---------- */}
      <TarotApp
        initialStage="input"
        initialType={typeId}
        showHome={false}
        showReadingHeader
      />
    </>
  );
}

/**
 * ⚠️ 顶栏（返回 + 分类名 + 风格切换）
 * ⚠️ 风格切换由 TarotApp 内部控制（它有 personas / persona state）
 */
function ReadingHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}) {
  return (
    <header className="fixed inset-x-0 top-0 z-30 flex items-center justify-between gap-3 px-4 py-3 pointer-events-none">
      {/* ⚠️ 渐变遮罩：顶栏是 fixed → 需要一层底色，否则透出 body 的黑色 ❌ */}
      <span
        className="absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(to bottom, rgba(4,2,12,0.92) 0%, rgba(4,2,12,0.72) 55%, rgba(4,2,12,0) 100%)",
        }}
      />
      <button
        type="button"
        onClick={onBack}
        className="pointer-events-auto group flex items-center gap-1.5 rounded-full border border-[rgba(212,175,55,0.28)] bg-[rgba(9,5,20,0.72)] backdrop-blur-md px-3 py-1.5 text-[12px] tracking-[0.14em] text-[rgba(255,248,235,0.85)] transition-all hover:border-[rgba(240,217,138,0.6)]"
      >
        <span aria-hidden className="transition-transform group-hover:-translate-x-0.5">←</span>
        首页
      </button>

      {title && (
        <span
          className="pointer-events-none text-[15px] tracking-[0.2em] text-[rgba(255,244,214,0.92)]"
          style={{
            fontFamily: "'Ma Shan Zheng', serif",
            textShadow: "0 2px 12px rgba(8,4,20,0.95), 0 0 26px rgba(8,4,20,0.8)",
          }}
        >
          {title}
        </span>
      )}

      {/* 占位（保持左右对称，风格切换按钮由 TarotApp 内部渲染） */}
      <div className="w-[72px]" />
    </header>
  );
}

/**
 * ⚠️ PPR：`useSearchParams` 必须在 **Suspense 边界内**
 */
export default function ReadingPage() {
  return (
    <Suspense fallback={<div className="min-h-[100dvh]" />}>
      <ReadingInner />
    </Suspense>
  );
}
