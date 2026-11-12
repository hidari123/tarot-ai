"use client";

/**
 * WitchOrb —— 小女巫抱水晶球 · 球内动效（2026-11-12 最终版）
 *
 * ⚠️⚠️⚠️ 用户最终要求（原文）：
 *   「小女孩透明度不够 还需要继续降低透明度」
 *   「球应该出现在『倾听星辰的低语 xxxxx』下面 然后中间留出距离
 *     球在这个位置 在下面再出现文字」
 *   「不用动了 就用这个图去当背景 你不要再处理了」
 *   「你往球里面加点动效吧」
 *
 * ⚠️⚠️ 结构：**用户原图（仅去白底）+ 两层同图叠加 + 球内 CSS 动效**
 *   · 图（`orb-witch-bg.png`）：**用户原图**，只做了「白底→透明」+ 边缘羽化
 *     · 不改颜色、不改亮度、不抠图 ✅
 *   · 底层：整张图 + `opacity: GIRL_ALPHA` → 女孩半透明
 *   · 上层：**只有球**（mask 挖掉球以外）→ 实心，覆盖底层的淡球
 *   · 动效层：叠在球上（圆形裁剪 → 动效不溢出）
 *
 * ⚠️⚠️⚠️ 球的位置：**由占位块决定**（不是绝对计算）
 *   · 用户要求「球在副标题下面，然后中间留出距离，下面再出现文字」
 *   → 页面里在副标题和入口卡片之间放一个**占位块**（见 page.tsx）
 *   → 本组件用 `document.querySelector('[data-orb-slot]')` 找到它
 *   → **球的中心 = 占位块的中心** → 位置永远正确，不会和内容重叠 ✅
 *   · ⚠️ 之前用纯公式算位置（SHIFT_Y_VH）→ 和内容流脱节 → 实测重叠 ❌
 */

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/**
 * 球在源图（1024×1024）里的位置
 * ⚠️⚠️ 2026-11-12 **程序化检测**（scripts/dev/_dbg_ball6.mjs，用户新图）
 *   → 暖黄色相筛选 → 最宽行 y=590, x 411..595（宽 185）
 *   → 圆心 (503, 595)，半径 93（= 最宽行宽度 / 2）
 *   → 验证图 shots/gen/_ballcheck.png 红圈**精确贴合** ✅
 *
 * ⚠️⚠️ 为什么必须程序化检测（网格目测会放大误差）：
 *   · 网格图是 2 倍缩放 → 每个像素的读数误差也 ×2 → 半径差好几个像素
 *   · 之前用目测值 (499, 602, r=101) → 球**偏右上**（用户反馈「定位还是有问题」）
 *
 * ⚠️⚠️ 半径不能用"行范围的高度 / 2"：
 *   · 球的上缘是高光、下缘被手挡 → 饱和度筛选只取到球芯
 *   → 算出的半径只有 51（太小）❌
 *   → 必须用**最宽行的宽度 / 2**（过球心的水平线 → 宽度 = 直径）✅
 */
const SRC = 1024;
const BALL_CX = 503;
const BALL_CY = 595;
const BALL_R = 93;

/** 背景层容器宽度（vw） */
const BG_W = 112;

/** 女孩部分的透明度（CSS opacity） */
const GIRL_ALPHA = 0.22;

/**
 * ⚠️ 球的垂直偏移（vh）
 * ⚠️⚠️ 目的：**让图里那颗球落在占位块（`[data-orb-slot]`）的中心**
 * ⚠️ 推导（1200×900 视口）：
 *   · 图渲染边长 S = min(112vw, 100vh) = 900
 *   · 图里球的 y = 595/1024 × 900 = 523
 *   · 占位块中心 = 副标题下方约 324
 *   → 图要上移 523 − 324 = 199px = 22.1vh
 * ⚠️ ⚠️ 为什么用 vh 而不是 px：
 *   · 球的自然位置 ∝ S（视口相关）→ 用 vh 表达才能在不同视口下等比
 * ⚠️ ⚠️ 占位块的高度必须与球的直径**同源**（见 page.tsx）：
 *   → 两处都用 min(20.3vw, 18.2vh) 这个值
 */
const BALL_SHIFT_VH = -26;

interface BallPos {
  /** 相对背景层容器的坐标 */
  x: number;
  y: number;
  d: number;
  /** CSS mask：只保留球的区域 */
  mask: string;
}

export default function WitchOrb() {
  const bgRef = useRef<HTMLDivElement>(null);
  const [ball, setBall] = useState<BallPos | null>(null);

  useEffect(() => {
    const measure = () => {
      const bg = bgRef.current;
      const img = bg?.querySelector("img");
      if (!bg || !img) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const containerW = (BG_W / 100) * vw;
      const S = Math.min(containerW, vh);
      const scale = S / SRC;

      const imgRect = img.getBoundingClientRect();
      const bgRect = bg.getBoundingClientRect();
      /** 图在 img 元素内的实际渲染位置（水平居中、顶部对齐） */
      const imgLeftInElem = (imgRect.width - S) / 2;

      /** 球的显示直径 */
      const d = BALL_R * 2 * scale;

      /**
       * ⚠️⚠️ 球的中心：**优先用占位块**（用户要「球在副标题下面，中间留距离」）
       * · 占位块由页面渲染（`[data-orb-slot]`）
       * · 它的位置就代表"球该在的位置" → 内容和构图永远同步 ✅
       * · 找不到占位块时（比如组件被复用到别处）→ 回退到公式计算
       */
      /**
       * ⚠️⚠️ 球的中心 = **图里那颗球**的位置（不是占位块）
       * ⚠️ 为什么（实测踩坑）：
       *   · 动效层必须和"球图那一层"重合 → 两者的球必须同位
       *   · 球图那一层是整张图（mask 挖出球）→ 球在图里的位置由源图坐标决定
       *   → 所以动效层也必须用**图里的球心** ✅
       *   · 占位块的作用只是**让下面的内容下移**（避免重叠），
       *     不参与球的定位 ⚠️ 混用会导致动效和球分离（实测 v82）
       */
      const bx = imgRect.left - bgRect.left + imgLeftInElem + BALL_CX * scale;
      const by = imgRect.top - bgRect.top + BALL_CY * scale;

      /**
       * mask：只保留球的区域（球以外透明）
       * ⚠️ 百分比相对 **img 元素** → 已在上面换算
       */
      const maskX = ((imgLeftInElem + BALL_CX * scale) / imgRect.width) * 100;
      const maskY = ((BALL_CY * scale) / imgRect.height) * 100;
      const maskR = (BALL_R * scale / imgRect.width) * 100;

      /**
       * ⚠️ mask：**只保留球的区域**，边缘**大幅模糊化**
       * ⚠️⚠️ 用户要求（原文）：「球图需要边缘模糊化 目前还是太实了」
       *   之前的渐变带太窄（0.72R → 1.06R）→ 边缘几乎是硬边 → 球"贴"在背景上 ❌
       * → 改成：实心区缩到 **0.55R**，然后一路渐隐到 **1.35R**
       *   · 渐变带宽度 = 0.8R（球的半径的 80%）→ 非常柔和
       *   · 边缘像"光化开"，不是被切一刀 ✅
       *   · ⚠️ 渐变带到 1.35R 会超出球本体 → 但因为**底层也是同一张图**，
       *     超出的部分是"球的颜色变淡" → 视觉上就是光晕 ✅
       */
      const mask =
        `radial-gradient(circle at ${maskX.toFixed(2)}% ${maskY.toFixed(2)}%, ` +
        `#fff 0%, rgba(255,255,255,0.92) ${(maskR * 0.55).toFixed(2)}%, ` +
        `rgba(255,255,255,0.45) ${(maskR * 0.95).toFixed(2)}%, ` +
        `rgba(255,255,255,0.12) ${(maskR * 1.18).toFixed(2)}%, ` +
        `rgba(255,255,255,0) ${(maskR * 1.38).toFixed(2)}%)`;

      setBall((prev) => {
        const next = { x: bx, y: by, d, mask };
        if (
          prev &&
          Math.abs(prev.x - next.x) < 0.5 &&
          Math.abs(prev.y - next.y) < 0.5 &&
          Math.abs(prev.d - next.d) < 0.5 &&
          prev.mask === next.mask
        ) {
          return prev;
        }
        return next;
      });
    };

    /**
     * ⚠️⚠️ measure 的调用时机（实测踩坑）
     * · 占位块 `[data-orb-slot]` 在 JSX 里排在 <WitchOrb /> **之后**
     *   → 首次 effect 执行时它还没进 DOM → querySelector 返回 null
     *   → ball 一直是 null → 动效层不渲染 ❌（实测 v82）
     * → 修法：**轮询重试**（直到找到占位块）
     *   · 最多 20 次 × 100ms = 2s（足够覆盖 React 提交）
     *   · 找到后立刻 measure 并停止轮询
     */
    let tries = 0;
    const tryMeasure = () => {
      const slot = document.querySelector("[data-orb-slot]");
      measure();
      if (!slot && tries < 20) {
        tries++;
        setTimeout(tryMeasure, 100);
      }
    };

    tryMeasure();
    if (document.fonts?.ready) document.fonts.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div
      ref={bgRef}
      /**
       * ⚠️⚠️ 为什么必须显式 `w-full left-0`：
       *   父级 <main> 是 `flex flex-col items-center`
       *   → flex 容器会**收缩** absolute 子元素的交叉轴尺寸
       *   → 不写 w-full 宽度会变成 0（内容不可见）
       *
       * ⚠️ 为什么 `absolute` 而不是 `fixed`：
       *   用户要求「小女孩也是能随着页面跟球一样滚动的」
       *   → fixed 钉在视口 → 滚动时不动 ❌
       *   → absolute 在文档流里 → 跟着内容滚走 ✅
       */
      className="pointer-events-none absolute left-0 top-0 z-0 w-full overflow-hidden"
      style={{ height: "160vh" }}
      aria-hidden="true"
    >
      {/* ① 底层：整张图 + 女孩半透明（球也淡） */}
      <motion.img
        src="/images/celestial/orb-witch-bg.png"
        alt=""
        draggable={false}
        initial={{ opacity: 0 }}
        animate={{ opacity: GIRL_ALPHA }}
        transition={{ duration: 2.2, ease: "easeOut" }}
        className="absolute left-1/2 top-0 max-w-none object-contain object-top"
        style={{
          /**
           * ⚠️⚠️⚠️ 为什么 className 里必须有 `max-w-none`（2026-11-10 实测踩坑）：
           *   Tailwind preflight 给所有 img 加了 `max-width: 100%`
           *   → 我写的 `width: 112vw` 被**限制成父容器的 100%**（100vw）
           *   → 背景层实际渲染宽度 744px 而不是预期的 833px
           *   → JS 里按 `min(112vw, 100vh)` 算 S，与实际渲染对不上 → 球和动效对不上
           *
           * ⚠️⚠️ transform 必须写全（2026-11-11 实测踩坑）：
           *   `left-1/2` 只是把图左边缘放到父容器中点
           *   → 必须再 translateX(-50%) 把图自身中心对到中点
           *   ⚠️ 之前我把 transform 写进 style 时**只写了 translateY**，
           *      把 Tailwind 的 `-translate-x-1/2` 覆盖掉了 → 图跑到右边 ❌
           *
           * ⚠️ 高度固定 100vh（不是 100%）：
           *   容器是 160vh，若图用 height:100% → S = min(112vw, 160vh) → 球会大一倍
           */
          width: `${BG_W}vw`,
          height: "100vh",
          objectPosition: "center top",
          transform: `translateX(-50%) translateY(${BALL_SHIFT_VH}vh)`,

        }}
      />

      {/* ①-2 上层：只有球（mask 挖掉球以外）→ 实心盖住底层的淡球 */}
      {ball && (
        <motion.img
          src="/images/celestial/orb-witch-bg.png"
          alt=""
          draggable={false}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 2.2, ease: "easeOut" }}
          className="absolute left-1/2 top-0 max-w-none object-contain object-top"
          style={{
            width: `${BG_W}vw`,
            height: "100vh",
            objectPosition: "center top",
            transform: `translateX(-50%) translateY(${BALL_SHIFT_VH}vh)`,
            maskImage: ball.mask,
            WebkitMaskImage: ball.mask,
            /**
             * ⚠️ 轻微模糊 → 消除抠图的锯齿，让边缘"化开"
             * ⚠️ 为什么 blur 不会让球变糊：
             *   球是纯色渐变的大面积区域 → blur 几乎不改变内部
             *   只影响边缘 1~2px 的锯齿 → 视觉上更自然 ✅
             */
            filter: "blur(1.2px)",
          }}
        />
      )}

      {/*
       * ② 球内动效：**小球（浮游光点）**，不是覆盖整个球的大光圈
       * ⚠️⚠️ 用户要求（原文）：
       *   「动效需要往下一点 边缘还要模糊 我需要的是小动态浮游的那种光圈
       *     不是一整个大的 是在魔法球里面的那种」
       *
       * ⚠️ 之前的问题：
       *   · 动效层是**和球一样大**的 conic 光带 → 看起来像"整个球在转" ❌
       *   · 用户要的是**球内部的小光点**在浮游 ✅
       *
       * ⚠️ 现在的做法：
       *   · 动效容器 = 球的**中心区域**（球的 62%）→ 光点只在球芯附近游动
       *   · 每个光点 = 一个小圆 + box-shadow 复制出多个
       *   · 动画 = 各自漂移（不同方向/周期）→ 浮游感
       */}
      {ball && (
        <div
          className="absolute overflow-hidden rounded-full"
          style={{
            left: ball.x - ball.d / 2,
            top: ball.y - ball.d / 2,
            width: ball.d,
            height: ball.d,
          }}
        >
          {/* ②-1 内部柔光（很淡，只提亮球芯） */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at 50% 52%, " +
                "rgba(255,252,238,0.30) 0%, " +
                "rgba(255,236,180,0.10) 34%, " +
                "rgba(255,210,120,0) 62%)",
              animation: "witch-orb-breathe 5.2s ease-in-out infinite",
            }}
          />

          {/* ②-2 浮游光点组 A（向右下漂） */}
          <div className="absolute inset-0">
            <div
              className="absolute h-[3px] w-[3px] rounded-full"
              style={{
                left: "42%", top: "46%",
                background: "rgba(255,253,242,0.98)",
                boxShadow:
                  "0 0 7px 2px rgba(255,246,208,0.85), " +
                  "13px 8px 0 0 rgba(255,238,190,0.7), " +
                  "-11px 12px 0 0 rgba(255,250,225,0.6), " +
                  "20px -6px 0 0 rgba(255,232,170,0.5), " +
                  "-18px -4px 0 0 rgba(255,244,200,0.55), " +
                  "26px 16px 0 0 rgba(255,236,180,0.4)",
                filter: "blur(0.4px)",
                animation: "witch-orb-float-a 7.5s ease-in-out infinite",
              }}
            />
          </div>

          {/* ②-3 浮游光点组 B（向左上漂，错开相位） */}
          <div className="absolute inset-0">
            <div
              className="absolute h-[2px] w-[2px] rounded-full"
              style={{
                left: "56%", top: "55%",
                background: "rgba(255,250,226,0.95)",
                boxShadow:
                  "0 0 6px 1px rgba(255,240,196,0.8), " +
                  "-14px -9px 0 0 rgba(255,246,214,0.6), " +
                  "16px 12px 0 0 rgba(255,234,178,0.5), " +
                  "-20px 8px 0 0 rgba(255,248,220,0.45), " +
                  "10px -14px 0 0 rgba(255,230,166,0.4)",
                filter: "blur(0.4px)",
                animation: "witch-orb-float-b 9.3s ease-in-out infinite 1.4s",
              }}
            />
          </div>

          {/* ②-4 浮游光点组 C（垂直小幅浮动） */}
          <div className="absolute inset-0">
            <div
              className="absolute h-[2px] w-[2px] rounded-full"
              style={{
                left: "48%", top: "52%",
                background: "rgba(255,248,214,0.9)",
                boxShadow:
                  "0 0 5px 1px rgba(255,244,204,0.7), " +
                  "9px -13px 0 0 rgba(255,238,190,0.5), " +
                  "-11px -9px 0 0 rgba(255,250,230,0.45), " +
                  "18px 6px 0 0 rgba(255,232,170,0.4)",
                filter: "blur(0.5px)",
                animation: "witch-orb-float-c 11s ease-in-out infinite 3s",
              }}
            />
          </div>

          {/* ②-5 球心的一点高光（呼吸） */}
          <div
            className="absolute left-1/2 top-1/2 h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              background: "rgba(255,255,250,0.9)",
              boxShadow: "0 0 12px 4px rgba(255,246,210,0.7)",
              animation: "witch-orb-breathe 3.6s ease-in-out infinite",
            }}
          />
        </div>
      )}    </div>
  );
}
