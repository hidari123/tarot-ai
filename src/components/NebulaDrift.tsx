"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * NebulaDrift —— 横向漂移的星云层（2026-11-13 · 方案 A）
 *
 * ⚠️⚠️⚠️ 最终形态（用户明确要求 + 多轮踩坑的结论）：
 *   "一张32:9的图片 从左到右慢速移动 像星云效果"
 *   "跟现在的背景一样"（现有背景用 background-size: cover → 永远铺满）
 *
 * ⚠️ 为什么用 background-image + background-position（而不是 <img>）：
 *   · 现有背景 bg-home.webp 用 `background-size: cover` → **永远铺满，无黑边** ✅
 *   · 而 <img> + height:100% 会等比放大 → 宽高比不同时留黑边 ❌
 *   → 统一用 background 方案 → 与现有背景行为一致 ✅
 *
 * ⚠️⚠️ 平移为什么用**像素**而不是百分比（实测坑）：
 *   · background-position 的百分比是相对（背景图尺寸 − 容器尺寸）算的
 *     而背景图被 cover 缩放过 → 这个基准是错的
 *     → 平移时图像在容器内错位 → **出现明显断带**（用户当时指出过）❌
 *   → 改用**像素值**（`0px` → `-Npx`）→ 精确、无错位 ✅
 *
 * ⚠️⚠️ 关键：素材必须"可平铺"才能无缝循环
 *   · 素材 = 原图 + 镜像（原图宽 = N）→ 平移 N 像素后接回起点 ✅
 *   · background-repeat: repeat-x → 超出部分自动补上 ✅
 *
 * ⚠️ 星星：独立层、**不跟随平移**（用户："星星不用平移 平移背景就可以了"）
 *   · 复用 CelestialBackdrop 的星尘思路：三档景深 + twinkle + boxShadow 光芒
 *   · 必须独立于 filter（filter 作用于整棵子树 → 星星会被压暗 ❌）
 */

interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
  d: number;
  delay: number;
}

/** 星点数量（按景深分配：近 / 中 / 远） */
const STAR_COUNTS = [22, 40, 64];

export default function NebulaDrift({
  /** 图层配置（每层独立速度） */
  layers,
  /** 整体不透明度 */
  opacity = 1,
  /** 是否加闪烁的星星 */
  showStars = true,
  /** 星星总数量倍率 */
  starDensity = 1,
  className = "",
}: {
  layers: {
    /** 图片路径（拼接好的长图） */
    src: string;
    /**
     * 单段的像素宽度
     * ⚠️ 平移距离 = 这个值（走完一段 → 无缝接回）
     */
    segWidth: number;
    /** 漂移周期（秒）→ 越大越慢 */
    duration?: number;
    /** 该层不透明度 */
    alpha?: number;
    /** 模糊（px）→ 加深雾感 */
    blur?: number;
    /** 亮度调整（0-2，1 = 不变）→ 压暗星云让它退成底纹 */
    brightness?: number;
    /** 色相旋转（deg）→ 校正配色（粉 → 紫） */
    hue?: number;
    /** 饱和度（0-3，1 = 不变） */
    saturate?: number;
    /** 背景定位（cover 时的取景位置） */
    position?: string;
    /** 该层是否带闪烁星星 */
    stars?: boolean;
    /**
     * ⚠️ 中心挖空遮罩（方案 B）
     * ⚠️ 用来给人物/魔法阵留一块"干净的深色背景"
     */
    centerHole?: {
      /** 椭圆横向半径（%） */
      w: number;
      /** 椭圆纵向半径（%） */
      h: number;
      /** 中心位置 X（%） */
      x: number;
      /** 中心位置 Y（%） */
      y: number;
      /** 中心的遮罩浓度（0-1）→ 越大越黑 */
      inner: number;
      /** 保持全浓度到椭圆半径的百分之多少 */
      core?: number;
      /** 边缘的遮罩浓度（0-1） */
      outer: number;
    };
  }[];
  opacity?: number;
  showStars?: boolean;
  starDensity?: number;
  className?: string;
}) {
  const [stars, setStars] = useState<Star[]>([]);

  /**
   * ⚠️ 必须 defer 到客户端 effect：
   *   Next.js 16 预渲染禁用 Math.random（会被烘进静态壳 → 所有页面星图一样）。
   */
  useEffect(() => {
    if (!showStars) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStars(
      STAR_COUNTS.flatMap((count, depth) =>
        Array.from({ length: Math.round(count * starDensity) }, () => {
          // 景深越大 → 越小越暗
          const scale = 1 - depth * 0.3;
          return {
            x: Math.random() * 100,
            y: Math.random() * 100,
            r: (Math.random() * 2.2 + 1.1) * scale,
            o: (Math.random() * 0.45 + 0.55) * scale,
            d: Math.random() * 5 + 2.5,
            delay: Math.random() * 6,
          };
        })
      )
    );
  }, [showStars, starDensity]);

  /** 每层星星的纵向错开（避免两层星星位置雷同） */
  const layerStars = useMemo(
    () =>
      stars.map((s, i) => ({
        ...s,
        y: (s.y + i * 37) % 100,
      })),
    [stars]
  );

  return (
    <div
      className={`absolute inset-0 pointer-events-none overflow-hidden ${className}`}
      style={{ opacity }}
      aria-hidden
    >
      {layers.map((l, i) => {
        const duration = l.duration ?? 90;
        return (
          <div key={l.src + i} className="absolute inset-0 overflow-hidden">
            {/**
             * ⚠️ 星云层：background-image + cover + 像素平移
             * · background-size: cover → **永远铺满，无黑边** ✅（与现有背景一致）
             * · background-repeat: repeat-x → 素材超出部分自动补 ✅
             * · background-position 动画：0px → -segWidth px（走完一段 → 无缝）✅
             * ⚠️ 关键：平移必须用**像素**（百分比在 cover 后基准是错的）
             */}
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `url(${l.src})`,
                backgroundRepeat: "repeat-x",
                backgroundSize: "cover",
                backgroundPosition: `${l.position ?? "center center"}`,
                opacity: l.alpha ?? 1,
                filter: [
                  l.blur ? `blur(${l.blur}px)` : "",
                  l.brightness !== undefined ? `brightness(${l.brightness})` : "",
                  l.hue !== undefined ? `hue-rotate(${l.hue}deg)` : "",
                  l.saturate !== undefined ? `saturate(${l.saturate})` : "",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined,
                animation: `nebula-pan ${duration}s ease-in-out infinite alternate`,
                /**
                 * ⚠️ 平移距离（像素）
                 * ⚠️ 用 CSS 变量传入（keyframe 里要用）
                 */
                "--nebula-shift": `${l.segWidth}px`,
              } as React.CSSProperties}
            />

            {/**
             * ---- 中心挖空遮罩（2026-11-13 · 方案 B）----
             *
             * ⚠️⚠️ 为什么需要（用户反馈）：
             *   「底色是粉色的这个动态的移动的背景 上面的小女孩和旋转的占卜的那个圆盘
             *    都变得不清晰了」
             *
             * ⚠️ 根本原因：
             *   · 旧静态背景 bg-home.webp 的构图是「中心空场（深蓝黑）+ 左上有星云」
             *   · 人物和魔法阵正好落在**空场**里 → 有干净的深色背景 → 轮廓清晰 ✅
             *   · 而流动星云是**满屏弥散**的 → 人物周围没有暗区
             *     → 她的暗部（头发阴影、衣服）和背景亮度接近 → 剪影消失 ❌
             *   → 解法：**在中心挖一个洞**，恢复「中心空场」的构图逻辑 ✅
             *
             * ⚠️ 遮罩的形状是径向椭圆（不是圆形）：
             *   · 人物在页面上半部分（y 约 10~55%）→ 洞要偏上
             *   · 横向要够宽（覆盖魔法阵直径 约 620px）
             */}
            {l.centerHole && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `radial-gradient(
                    ellipse ${l.centerHole.w}% ${l.centerHole.h}% at ${l.centerHole.x}% ${l.centerHole.y}%,
                    rgba(7, 4, 16, ${l.centerHole.inner}) 0%,
                    rgba(7, 4, 16, ${l.centerHole.inner}) ${l.centerHole.core ?? 38}%,
                    rgba(7, 4, 16, ${l.centerHole.outer}) 72%,
                    rgba(7, 4, 16, 0) 100%
                  )`,
                }}
              />
            )}

            {/**
             * ⚠️ 星星层：独立于 filter 的兄弟节点
             * · 用户要求「星星不用平移」→ 只有 twinkle，没有 nebula-pan ✅
             * · 独立于 filter → 不会被 brightness 压暗 ✅
             */}
            {showStars && l.stars !== false && (
              <div className="absolute inset-0 overflow-hidden pointer-events-none">
                {layerStars.map((st, si) => (
                  <span
                    key={si}
                    className="absolute rounded-full bg-purple-100"
                    style={{
                      left: `${st.x}%`,
                      top: `${st.y}%`,
                      width: st.r,
                      height: st.r,
                      opacity: st.o,
                      animation: `twinkle-bright ${st.d}s ease-in-out ${st.delay}s infinite`,
                      boxShadow: `0 0 ${st.r * 4}px rgba(230, 200, 255, ${st.o * 0.95}), 0 0 ${st.r * 8}px rgba(196, 130, 255, ${st.o * 0.45})`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
