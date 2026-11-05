"use client";

import { useEffect, useState } from "react";
import AstralCircle from "@/components/AstralCircle";

/**
 * 深空占卜室 · 背景（2026-11-05 视觉重设计 · 第 1 批）
 *
 * ⚠️⚠️ 为什么不用几个 `radial-gradient` 拼了事：
 *   纯 CSS 渐变看起来"塑料" —— 原因是它**没有纹理、没有景深、没有光衰减**。
 *   真实摄影/插画里的深空是：① 有颗粒 ② 光源会衰减 ③ 远近不同清晰度。
 *   → 这个组件把三层补齐：
 *      · 噪点（SVG feTurbulence）—— 胶片颗粒，去掉"塑料感"
 *      · 多光源 + 暗角 —— 光衰减，视线收进中心
 *      · 三档景深星尘 —— 近大亮、远小暗
 *
 * ⚠️ 为什么星点要分三档（而不是随机大小）：
 *   随机大小 = 看起来像"贴在玻璃上的白点"（平）。
 *   分三档且**越远越暗越小** = 有纵深，像真的星空。
 *
 * ⚠️ 性能：
 *   · 星点在挂载后生成（Math.random 不能进预渲染 —— Next 16 会报错）
 *   · 噪点是**一张静态 SVG data-URI**（浏览器会缓存，不重绘）
 *   · 星云用 CSS 动画（GPU 合成，不触发 layout）
 *   → 整个背景只有 1 个 DOM 节点树 + 200 个 span，可接受。
 */

interface Star {
  x: number;
  y: number;
  /** 半径 */
  r: number;
  /** 亮度 */
  o: number;
  /** 闪烁周期 */
  d: number;
  /** 闪烁延迟 */
  delay: number;
  /** 景深层级 0=近 1=中 2=远 */
  depth: number;
}

/** 星点数量（按景深分配） */
const STAR_COUNTS = [40, 70, 110];

/** 生成噪点纹理（SVG feTurbulence，data-URI 形式 —— 浏览器可缓存） */
const NOISE_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

export default function CelestialBackdrop({
  /** 主光源色（可按页面调整：运势页偏金、占卜页偏紫） */
  tint = "rgba(139, 92, 246, 0.20)",
  /** 是否显示主光源（运势页可能不需要） */
  showPrimary = true,
  /** 是否叠加星象魔法阵 */
  showCircle = false,
  /** 魔法阵尺寸 */
  circleSize = 760,
  /** 魔法阵强度 */
  circleIntensity = 0.75,
  /** 魔法阵是否"激活"（亮起） */
  circleActive = false,
  className = "",
}: {
  tint?: string;
  showPrimary?: boolean;
  showCircle?: boolean;
  circleSize?: number;
  circleIntensity?: number;
  circleActive?: boolean;
  className?: string;
}) {
  const [stars, setStars] = useState<Star[]>([]);

  useEffect(() => {
    // ⚠️ 必须 defer 到客户端 effect：
    //   Next.js 16 预渲染禁用 Math.random（会被烘进静态壳 → 所有页面星图一样）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStars(
      STAR_COUNTS.flatMap((count, depth) =>
        Array.from({ length: count }, () => {
          // 景深越大 → 越小越暗
          const scale = 1 - depth * 0.3;
          return {
            x: Math.random() * 100,
            y: Math.random() * 100,
            r: (Math.random() * 1.6 + 0.4) * scale,
            o: (Math.random() * 0.5 + 0.3) * scale,
            d: Math.random() * 5 + 2.5,
            delay: Math.random() * 6,
            depth,
          };
        })
      )
    );
  }, []);

  return (
    <div
      /**
       * ⚠️⚠️⚠️ 必须显式 `w-full` + `self-stretch`（而不是只靠 `absolute inset-0`）：
       *   宿主 `<main>` 是 `flex flex-col items-center` ——
       *   ① flex 容器下，子元素的**交叉轴尺寸会按 align-items 收缩到内容宽度**
       *      （而不是撑满）→ 背景层只覆盖中间一小块
       *   ② `absolute inset-0` 的元素**不再参与 flex 布局**，但如果父级
       *      建立了包含块（transform/filter/will-change），
       *      `inset-0` 算的是那个包含块而非视口
       *   → 两个问题叠加，魔法阵中心偏左约 160px（截图实测）。
       *   → `w-full` + `self-stretch` 双保险：撑满交叉轴且不依赖百分比定位。
       */
      className={`absolute inset-0 w-full self-stretch overflow-hidden pointer-events-none ${className}`}
      aria-hidden
    >
      {/* ---- 层 1：深空底色（垂直渐变，顶部略亮） ---- */}
      <div
        className="absolute inset-0"
        style={{ background: "linear-gradient(180deg, #0b0618 0%, #07040f 45%, #05020a 100%)" }}
      />

      {/* ---- 层 2：主光源（顶部中央） ---- */}
      {showPrimary && (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 70% 50% at 50% -8%, ${tint}, transparent 70%)`,
          }}
        />
      )}

      {/* ---- 层 3：辅光（左下冷蓝 / 右下暗红） ----
           ⚠️ 为什么要辅光：单一光源会让页面"平"。
           两团极淡的补光能暗示"这个空间有多个维度"。 */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 50% 40% at 8% 95%, rgba(56, 89, 220, 0.09), transparent 65%)," +
            "radial-gradient(ellipse 45% 35% at 95% 88%, rgba(160, 60, 120, 0.07), transparent 65%)",
        }}
      />

      {/* ---- 层 4：星云（3 团缓慢漂移的大色斑） ----
           ⚠️ blur-3xl + 极低透明度 = 有体积的"气体"而不是色块 */}
      <div
        className="absolute -left-1/4 top-[15%] w-[70vw] h-[70vw] rounded-full opacity-[0.09] blur-3xl"
        style={{
          background: "radial-gradient(circle, #7c3aed 0%, transparent 68%)",
          animation: "nebula-drift-a 44s ease-in-out infinite",
        }}
      />
      <div
        className="absolute -right-1/4 top-[35%] w-[60vw] h-[60vw] rounded-full opacity-[0.07] blur-3xl"
        style={{
          background: "radial-gradient(circle, #2563eb 0%, transparent 68%)",
          animation: "nebula-drift-b 58s ease-in-out infinite",
        }}
      />
      <div
        className="absolute bottom-[-15%] left-[25%] w-[55vw] h-[55vw] rounded-full opacity-[0.06] blur-3xl"
        style={{
          background: "radial-gradient(circle, #a21caf 0%, transparent 68%)",
          animation: "nebula-drift-a 67s ease-in-out infinite reverse",
        }}
      />

      {/* ---- 层 5：星尘（三档景深） ---- */}
      {stars.length > 0 && (
        <div className="absolute inset-0">
          {stars.map((st, i) => (
            <span
              key={i}
              className="absolute rounded-full bg-purple-100"
              style={{
                left: `${st.x}%`,
                top: `${st.y}%`,
                width: st.r,
                height: st.r,
                opacity: st.o,
                animation: `twinkle ${st.d}s ease-in-out ${st.delay}s infinite`,
                boxShadow: `0 0 ${st.r * 3}px rgba(216, 180, 254, ${st.o * 0.7})`,
              }}
            />
          ))}
        </div>
      )}

      {/* ---- 层 6：噪点（胶片颗粒） ----
           ⚠️ 这一层是"从廉价到高级"性价比最高的一步：
           纯渐变背景最大的破绽就是"太干净"，加 3% 颗粒立刻有暗房质感。 */}
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{ backgroundImage: NOISE_URI, backgroundSize: "300px 300px" }}
      />

      {/* ---- 层 7：暗角（把视线收进中心） ----
           ⚠️ 这一层制造"景深"：边缘压暗 → 中心内容浮出来。 */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 75% 65% at 50% 45%, transparent 35%, rgba(2, 1, 6, 0.55) 100%)",
        }}
      />

      {/* ---- 层 8：星象魔法阵（可选） ----
           ⚠️ 为什么魔法阵要放在**这个宿主里面**（而不是页面里自己定位）：
             页面级定位（absolute/fixed + 百分比）会因为祖先的 transform /
             filter / backdrop-filter 而偏移（实测三次都跑偏）。
             → 让这个已经是 inset-0 的层做 flex 居中 → 位置永远正确。 */}
      {showCircle && (
        <div className="absolute inset-0 flex items-center justify-center">
          <AstralCircle size={circleSize} intensity={circleIntensity} active={circleActive} />
        </div>
      )}
    </div>
  );
}
