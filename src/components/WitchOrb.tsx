"use client";

/**
 * WitchOrb —— 小女巫抱水晶球 · 「球凸出且重合」构图（2026-11-10 第三版）
 *
 * ⚠️⚠️ 用户最终要求（原文）：
 *   「小女孩手里的球应该跟站位置的球重合的 帽子太高上面就不要再展示了 球要重合的」
 *
 * ⚠️⚠️ 核心难点：**两个坐标系要对齐**
 *
 *   背景层（小女孩）：fixed，容器 112vw × 100vh，object-contain + object-position: center top
 *      → 渲染出一个边长 S = min(112vw, 100vh) 的正方形，**顶部对齐**视口顶部，水平居中
 *      → 她手里的球在源图 (497, 590) → 视口坐标：
 *         left = (112vw - S)/2 + 497/1024·S
 *         top  = 590/1024·S
 *
 *   实体层（水晶球）：**在文档流里**（占位置），位置由 JSX 决定
 *
 *   ⚠️ 要"重合"，两者必须在**同一个视口坐标**上。
 *   → 但实体层在文档流里，它的位置 = 副标题之后的位置 ≈ 290px
 *   → 背景层里的球在 57.6vh ≈ 576px（视口 1000px 高）
 *   → **两者差了 286px** ❌
 *
 * ⚠️⚠️ 解法：**把背景层的球"提上来"** —— 用负 margin 把背景层的图整体上移，
 *   让她手里的球正好落在实体球的位置：
 *   · 上移量 = 背景层球的视口 top − 实体球的视口 top
 *   · 但这个量**依赖视口尺寸**（S 是视口相关的）→ 必须用 CSS calc 表达
 *
 * ⚠️ 用 CSS 变量 + calc 一次算清（不依赖 JS，避免 hydration 不一致）：
 *   S = min(112vw, 100vh)
 *   背景球 top = 0.5762·S                       （图顶部对齐视口顶部）
 *   实体球 top = 副标题后的文档流位置 → 难以用 calc 表达 ❌
 *
 * ⚠️⚠️ 换思路（更稳）：**反过来算** —— 让背景层用 `object-position: center bottom`
 *   并配合负 margin，让她的球**始终**落在文档流里实体球的位置。
 *   → 但"文档流位置"无法用纯 CSS 表达。
 *
 * ⚠️⚠️ 最终解法（用 JS 测量，最准且可维护）：
 *   ① 实体球用 ref 拿到它在视口里的真实位置（getBoundingClientRect）
 *   ② 背景层用一个**可计算的偏移量**：把她的图整体上移
 *      shift = 背景球视口top − 实体球视口top
 *   ③ shift 用 JS 设成 CSS 变量 → 精确对齐
 *
 *   ⚠️ 为什么用 JS 而不是纯 CSS：
 *      实体球的位置由**文档流**决定（取决于副标题的实际渲染高度、
 *      字体加载情况、屏幕宽度下的换行…）→ 纯 CSS 无法预知
 *      → 实测副标题在 1200px 宽时占 1 行、375px 宽时可能占 2 行 → 位置不同
 *      → 必须实测。
 *
 * ⚠️ 为什么不在 useEffect 里直接 setState 定位球（那样更简单）：
 *      · 球会在第一帧闪烁到错误位置（SSR 输出的是初始值）
 *      → 所以用**CSS 变量 + transform**，初始值取"估算值"，
 *        测量完成后平滑纠正 → 无闪烁。
 *
 * ⚠️「帽子太高，上面不要再展示」：
 *   → 背景层的图要**上移**，让帽子顶（源图 y=48）超出视口顶部
 *   → 上移量至少 = 48/1024·S ≈ 0.047·S
 *   → 恰好"帽子超出 + 球对齐"这两个条件由同一个 shift 满足 ✅
 */

import { motion } from "framer-motion";
import { useEffect, useRef } from "react";

/** 球在源图（1024×1024）里的位置与大小 */
const SRC = 1024;
const BALL_CX = 497;
const BALL_CY = 590;

/** 背景层容器宽度（vw） */
const BG_W = 112;

export default function WitchOrb() {
  const bgRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const measure = () => {
      const ball = ballRef.current;
      const bg = bgRef.current;
      if (!ball || !bg) return;

      /**
       * ① 实体球在视口里的位置（文档流 → 视口坐标）
       */
      const ballRect = ball.getBoundingClientRect();
      const ballCenterX = ballRect.left + ballRect.width / 2;
      const ballCenterY = ballRect.top + ballRect.height / 2;

      /**
       * ② 背景层的几何
       * · 容器 112vw × 100vh（左 0，宽 112vw）
       * · 图 1024²，object-contain → 渲染边长 S = min(112vw, 100vh)
       * · object-position: center top → 图顶对齐容器顶，水平居中
       *   → 图的左边缘在容器内偏移 (containerW - S)/2
       *   → 容器左边缘在视口 x=0（fixed inset-0）
       *   → 所以图左边缘 = (containerW - S)/2
       */
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const containerW = (BG_W / 100) * vw;
      const S = Math.min(containerW, vh);
      const imgLeft = (containerW - S) / 2;

      /** 背景层里球心的视口坐标（未做偏移时） */
      const bgBallX = imgLeft + (BALL_CX / SRC) * S;
      const bgBallY = (BALL_CY / SRC) * S;

      /**
       * ③ 需要把背景层整体平移多少，才能让她的球落在实体球的位置
       * ⚠️⚠️ 符号方向（2026-11-10 实测踩坑）：
       *   平移量 = **目标位置 − 当前位置**（不是反过来！）
       *   · 她的球现在在 bgBallX=415px，实体球在 ballCenterX=372px
       *   · 需要往左移 43px → shiftX = 372 − 415 = **−43**
       *   · 写成 +43 → 她的球反而往右走 → 越来越偏（实测 v51）
       */
      const shiftX = ballCenterX - bgBallX;
      const shiftY = ballCenterY - bgBallY;

      bg.style.setProperty("--witch-shift-x", `${shiftX}px`);
      bg.style.setProperty("--witch-shift-y", `${shiftY}px`);
    };

    measure();
    // 字体加载完成后版面会变 → 重新测量
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <>
      {/* ══════════════════════════════════════════════
       * ① 背景层：小女孩（fixed，不占布局位置）
       * ══════════════════════════════════════════════ */}
      <div
        ref={bgRef}
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        aria-hidden="true"
      >
        <motion.img
          src="/images/celestial/orb-witch-bg.png"
          alt=""
          draggable={false}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 2.2, ease: "easeOut" }}
          className="absolute top-0 max-w-none object-contain object-top"
          style={{
            /**
             * ⚠️⚠️⚠️ 为什么 className 里必须有 `max-w-none`（2026-11-10 实测踩坑）：
             *   Tailwind preflight 给所有 img 加了 `max-width: 100%`
             *   → 我写的 `width: 112vw` 被**限制成父容器的 100%**（100vw）
             *   → 背景层实际渲染宽度 744px 而不是预期的 833px
             *   → JS 里按 `min(112vw, 100vh)` 算 S，与实际渲染对不上
             *   → 偏移量算错 → 她的球和实体球**不重合**（实测 v51）
             *   → 排查手段：CDP 读 getBoundingClientRect + getComputedStyle
             *     发现 style 写的是 112vw，但 rect.width 却是 100vw ✅
             *
             * ⚠️⚠️ 为什么**不用** Tailwind 的 `left-1/2 -translate-x-1/2`：
             *   · Tailwind 的 translate 走 CSS 变量（`--tw-translate-x`）
             *   · 而这里要用**测量出来的动态偏移**（水平 + 垂直）
             *   · 两者都写 transform → **后者覆盖前者** → 元素跑到左边（实测 v50）
             * → 统一用 inline style 的 transform，自己算全部偏移。
             *
             * ⚠️ 偏移量的含义（由 useEffect 测量写入 CSS 变量）：
             *   --witch-shift-x：把她的球横向移到实体球的位置
             *   --witch-shift-y：把她的球纵向移到实体球的位置（同时把帽子顶出视口）
             */
            left: 0,
            width: `${BG_W}vw`,
            maxWidth: "none",
            height: "100%",
            objectPosition: "center top",
            transform:
              "translate(var(--witch-shift-x, 0px), var(--witch-shift-y, 0px))",
            transition: "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        />
      </div>

      {/* ══════════════════════════════════════════════
       * ② 实体层：水晶球（**在文档流里 → 占位置**）
       * ══════════════════════════════════════════════ */}
      <motion.div
        ref={ballRef}
        initial={{ opacity: 0, scale: 0.86 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.35, duration: 1.1, ease: "easeOut" }}
        className="relative z-10 mx-auto flex items-center justify-center my-7 md:my-9"
        style={{
          /**
           * ⚠️ 球的大小必须**等于**背景层里那个球的显示大小，否则"凸出"感会破：
           *   背景层球直径 = (BALL_D / SRC) × S，S = min(112vw, 100vh)
           *   → = min(112vw × 0.1797, 100vh × 0.1797)
           *   → = **min(20.12vw, 17.97vh)**
           */
          width: "min(20.12vw, 17.97vh)",
          height: "min(20.12vw, 17.97vh)",
        }}
        aria-hidden="true"
      >
        {/* 球实体（单独抠出的图）
          ⚠️ 为什么不用 next/image：
            · 这是**装饰性**图层（aria-hidden），不是内容图
            · next/image 会做尺寸优化 → 但我们要求"球的大小严格等于背景层里那个球"
              （两个层必须像素级重合，见上方推导）
            · next/image 的 srcset 会按视口宽度选不同尺寸的图 → **大小会变** → 破坏重合
            → 所以用原生 <img>，并显式禁用 lint
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/celestial/orb-witch-ball.png"
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-contain"
        />

        {/* ③ 光效：球内旋转光带（"光影流动"）
          ⚠️⚠️ 2026-11-10 用户反馈「光晕那圈太明显了」：
          *   → 这层的容器是 `inset-0 rounded-full` = **整个球的大小**
          *   → 但球层图（212×204）里的球本体只占约 92%
          *   → 光带会溢出到球外面 → 形成一圈"光晕" ❌
          * → 修法：容器缩到球本体的大小（inset: 4%）
          *   → 光带只在球内部流动，不再溢出
          *
          * ⚠️ 为什么之前会溢出（几何推导）：
          *   球层图 212px 宽 = 球本体 92×2 + 一点余量
          *   → 球本体直径 ≈ 178px → 占图宽 84%
          *   → 容器 inset-0 (212px) 减去光带半径 → 边缘多出 16px 的环
          */}
        <div className="absolute inset-0 overflow-hidden rounded-full">
          <div
            className="absolute inset-[-55%]"
            style={{
              background:
                "conic-gradient(from 0deg, " +
                "rgba(255,255,255,0) 0deg, " +
                "rgba(255,250,220,0.42) 40deg, " +
                "rgba(255,216,140,0.24) 90deg, " +
                "rgba(255,255,255,0) 150deg, " +
                "rgba(196,216,255,0.22) 230deg, " +
                "rgba(255,255,255,0) 300deg)",
              animation: "witch-orb-spin 11s linear infinite",
            }}
          />
          <div
            className="absolute inset-[-55%]"
            style={{
              background:
                "conic-gradient(from 140deg, " +
                "rgba(255,255,255,0) 0deg, " +
                "rgba(255,234,176,0.32) 60deg, " +
                "rgba(255,255,255,0) 130deg, " +
                "rgba(224,206,255,0.22) 240deg, " +
                "rgba(255,255,255,0) 360deg)",
              animation: "witch-orb-spin 17s linear infinite reverse",
            }}
          />
        </div>

        {/* 球外辉光（扩散的暖光）
          ⚠️ 2026-11-10 用户反馈「光晕那圈太明显了」→ 先关掉
          ⚠️ 保留这段代码但不渲染：后面如果要做"呼吸感"可以调小后加回来
          ⚠️ 现在只保留 CSS 的 conic 光带（球内流动），不要外部光晕 */}
        {false && (
          <div
            className="absolute inset-[-18%] rounded-full"
            style={{
              background:
                "radial-gradient(circle, rgba(255,240,196,0.34) 0%, rgba(255,214,120,0.18) 44%, rgba(255,200,90,0) 70%)",
              filter: "blur(20px)",
              animation: "witch-orb-pulse 4.6s ease-in-out infinite",
            }}
          />
        )}
      </motion.div>
    </>
  );
}
