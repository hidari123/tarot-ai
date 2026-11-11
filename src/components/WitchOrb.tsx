"use client";

/**
 * WitchOrb —— 小女巫抱水晶球 · 单图 + 内部流光（2026-11-11 最终版）
 *
 * ⚠️⚠️⚠️ 用户最终要求（原文，四条）：
 *   ① 「跟目前页面是一样的展示形式」
 *   ② 「小女孩也是能随着页面跟球一样滚动的」
 *   ③ 「这个球 你截图位置不对 往右上角偏了」
 *   ④ 「你加的光晕那块 很明显 你加到球里面啊 不是加到外面」
 *
 * ⚠️⚠️ 逐条对应：
 *
 * ① 展示形式 = 小女孩半透明铺在页面**上部**（标题/副标题/入口卡片区）
 *
 * ② **跟着页面滚动**
 *    ⚠️ 之前用 `fixed` → 图钉在视口，滚动时不动 → 不符合仪式感
 *    → 改成 `absolute`（在文档流里的容器内）→ 滚动时跟着内容滚走 ✅
 *
 * ③ 球位置修正
 *    ⚠️ 实测（scripts/dev/_dbg_pos.mjs，1200×900）：
 *       图渲染宽 1344（112vw），高 900，S = min(1344,900) = 900
 *       图在元素内水平居中 → 左边距 (1344-900)/2 = 222
 *       图左边缘在视口 x = -72（translateX(-50%) 后）
 *       球心（源图 500,612）→ 视口 x = -72 + 222 + 439 = **589**
 *                                      y = 0 + 612/1024×900 = **538**
 *    → 球自然位置偏下（入口卡片区）→ 上移 288px 到副标题下方
 *    → `BALL_OFFSET_Y_RATIO = -0.32`（× S）
 *
 * ④ **光晕只在球内部**
 *    → 光晕层用 `rounded-full` + `overflow:hidden` → 圆形裁剪 → 光不会溢出
 *    → 删掉了之前的「外扩光晕」（1.9 倍大、blur 26px）—— 那就是用户说的"加到外面"
 *
 * ⚠️⚠️ 结构上的关键决策：**发光层放在背景层容器内部**
 *   · 两者是父子关系 → 用**相对容器的坐标** → 天然同步 ✅
 *   · 如果做成兄弟节点 → 要维护两套坐标 → 实测过一次光直接消失
 *   · 背景层容器 `absolute left-0 top-0 w-full h-100vh` → 坐标原点 = 容器左上角
 */

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

/**
 * 球在源图（1024×1024）里的位置
 * ⚠️ 2026-11-10 用「网格辅助目测」实测（scripts/dev/_dbg_grid.mjs）：
 *   球的上/下/左/右边界 ≈ 512 / 712 / 400 / 600
 *   → 圆心 (500, 612)，半径 100px
 */
const SRC = 1024;
const BALL_CX = 500;
const BALL_CY = 612;
const BALL_R = 100;

/** 背景层容器宽度（vw） */
const BG_W = 112;

/**
 * ⚠️ 球在容器内的纵向偏移（× S）
 * ⚠️ 球自然位置 y = 59.77% × S → 目标 ≈ 27.7% × S（副标题下方）
 * → 偏移 = -0.32 × S
 */
const BALL_OFFSET_Y_RATIO = -0.27;

interface GlowPos {
  /** 相对背景层容器的坐标 */
  x: number;
  y: number;
  d: number;
}

export default function WitchOrb() {
  const bgRef = useRef<HTMLDivElement>(null);
  const [glow, setGlow] = useState<GlowPos | null>(null);

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

      /**
       * ⚠️⚠️ 球的坐标：相对**背景层容器**
       *
       * ⚠️⚠️⚠️ 必须用 img.getBoundingClientRect() 实测（2026-11-11 实测踩坑）：
       *   我之前用**公式**算 img 在容器内的位置：
       *     imgLeftInElem = (containerW - S) / 2
       *   → 错在哪：
       *     ① img 元素本身是 `left-1/2 + translateX(-50%)` → 它的左边缘相对容器
       *        = 容器宽/2 − 112vw/2 = −(containerW)/2 + containerW/2... 实际上是负值
       *     ② 图（正方形 S×S）在 img 元素**内部**居中 → 又有一层偏移
       *   → 两层偏移叠加，公式算不准 → 球和光差了 85px（实测 v70）
       *   → **直接量 img 元素的 rect + 算图在元素内的位置**，用浏览器的真实布局 ✅
       */
      const imgRect = img.getBoundingClientRect();
      const bgRect = bg.getBoundingClientRect();

      /**
       * 图在 img 元素内的实际渲染矩形
       * · img 元素：宽 112vw（= containerW），高 100vh
       * · object-contain → 图渲染成 S×S 的正方形
       * · object-position: center top → 水平居中、顶部对齐
       *   → 图左边缘相对 img 元素 = (imgRect.width - S) / 2
       */
      const imgLeftInElem = (imgRect.width - S) / 2;

      /**
       * ⚠️ 球的视口坐标
       * · imgRect.left 是**视口**坐标
       * · 减去 bgRect.left → 转成**相对容器**的坐标（发光层要用这个）
       * ⚠️⚠️ 这里**不含** BALL_OFFSET_Y_RATIO：
       *   因为那个偏移是作用在**整张图**上的（图本身被 translateY 上移）
       *   → imgRect.top 已经反映了位移 ✅
       *   → 如果这里再减一次 → 偏移会算两遍（实测光和球差 85px）
       */
      const ballX = imgRect.left - bgRect.left + imgLeftInElem + BALL_CX * scale;
      const ballY = imgRect.top - bgRect.top + BALL_CY * scale;
      const d = BALL_R * 2 * scale;

      setGlow((prev) => {
        const next = { x: ballX, y: ballY, d };
        if (
          prev &&
          Math.abs(prev.x - next.x) < 0.5 &&
          Math.abs(prev.y - next.y) < 0.5 &&
          Math.abs(prev.d - next.d) < 0.5
        ) {
          return prev;
        }
        return next;
      });
    };

    measure();
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
       *   ⚠️ 这个坑之前踩过一次（背景层变成一条线）
       *
       * ⚠️ 为什么 `absolute` 而不是 `fixed`：
       *   用户要求「小女孩也是能随着页面跟球一样滚动的」
       *   → fixed 钉在视口 → 滚动时不动 ❌
       *   → absolute 在文档流里 → 跟着内容滚走 ✅
       */
      className="pointer-events-none absolute left-0 top-0 z-0 w-full overflow-hidden"
      /**
       * ⚠️⚠️ 高度为什么是 160vh 而不是 100vh：
       *   用户要求「小女孩也是能随着页面跟球一样滚动的」
       *   → 但首页内容几乎正好一屏（实测 docH 704 / winH 700）→ 只滚动 4px
       *   → 图钉在 100vh 内 → 几乎看不出"跟着滚动"
       *   → 容器高 160vh → 图占据页面上下 1.6 屏 → 滚动时有明显的位移感 ✅
       *
       * ⚠️ 高度变化会影响球的计算：
       *   · 图的渲染边长 S = min(112vw, **容器高**)
       *   · 容器高 160vh → 在 900px 视口下 S = min(1344, 1440) = 1344（比之前大！）
       *   → 球会变大 → 需要重新测参数
       *   → ⚠️ 用 JS 实测 img.getBoundingClientRect() 就自动适配了 ✅
       */
      style={{ height: "160vh" }}
      aria-hidden="true"
    >
      {/* ① 小女孩 + 球（**一张图**，半透明当底图） */}
      <motion.img
        src="/images/celestial/orb-witch-bg.png"
        alt=""
        draggable={false}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 2.2, ease: "easeOut" }}
        className="absolute left-1/2 top-0 max-w-none object-contain object-top"
        style={{
          /**
           * ⚠️⚠️⚠️ 为什么 className 里必须有 `max-w-none`（2026-11-10 实测踩坑）：
           *   Tailwind preflight 给所有 img 加了 `max-width: 100%`
           *   → 我写的 `width: 112vw` 被**限制成父容器的 100%**（100vw）
           *   → 背景层实际渲染宽度 744px 而不是预期的 833px
           *   → JS 里按 `min(112vw, 100vh)` 算 S，与实际渲染对不上
           *   → 发光层位置算错 → 球和光对不上
           *   → 排查手段：CDP 读 getBoundingClientRect + getComputedStyle
           *     发现 style 写的是 112vw，但 rect.width 却是 100vw ✅
           *
           * ⚠️⚠️⚠️ transform 必须写全（2026-11-11 实测踩坑）：
           *   `left-1/2` 只是把图左边缘放到父容器中点
           *   → 必须再 translateX(-50%) 把图自身中心对到中点
           *   ⚠️ 之前我把 transform 写进 style 时**只写了 translateY**，
           *      把 Tailwind 的 `-translate-x-1/2` 覆盖掉了
           *   → 图跑到 x=600（右半边）→ 人物在右下角 ❌
           */
          width: `${BG_W}vw`,
          height: "100vh",
          objectPosition: "center top",
          transform: `translateX(-50%) translateY(${BALL_OFFSET_Y_RATIO * 100}vh)`,
        }}
      />

      {/* ══════════════════════════════════════════════
       * ② 流光层：**只有球内部在发光**（用户要求 ④）
       *    ⚠️ 放在**背景层容器内部** → 坐标天然同步（相对容器的坐标）
       * ══════════════════════════════════════════════ */}
      {glow && (
        <div
          className="pointer-events-none absolute left-0 top-0 w-full overflow-hidden"
          style={{ height: "100%" }}
          aria-hidden="true"
        >
          {/* ②-1 球体辉光（**只在球内** → rounded-full + overflow-hidden 圆形裁剪） */}
          <div
            className="absolute overflow-hidden rounded-full"
            style={{
              left: glow.x - glow.d / 2,
              top: glow.y - glow.d / 2,
              width: glow.d,
              height: glow.d,
            }}
          >
            {/* 核心暖白光 */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(circle at 44% 36%, " +
                  "rgba(255,252,240,0.58) 0%, " +
                  "rgba(255,238,190,0.30) 42%, " +
                  "rgba(255,208,115,0.08) 70%, " +
                  "rgba(255,190,80,0) 100%)",
                animation: "witch-orb-breathe 4.6s ease-in-out infinite",
              }}
            />
            {/* 旋转光带（"光影流动"） */}
            <div
              className="absolute inset-[-55%]"
              style={{
                background:
                  "conic-gradient(from 0deg, " +
                  "rgba(255,255,255,0) 0deg, " +
                  "rgba(255,252,236,0.40) 40deg, " +
                  "rgba(255,224,164,0.22) 90deg, " +
                  "rgba(255,255,255,0) 150deg, " +
                  "rgba(202,222,255,0.20) 230deg, " +
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
                  "rgba(255,240,196,0.32) 60deg, " +
                  "rgba(255,255,255,0) 130deg, " +
                  "rgba(228,214,255,0.20) 240deg, " +
                  "rgba(255,255,255,0) 360deg)",
                animation: "witch-orb-spin 17s linear infinite reverse",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
