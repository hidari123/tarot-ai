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
  /**
   * ⚠️ AI 生成的背景图（2026-11-06）
   * ⚠️ 为什么加这个开关：
   *   CSS 渐变做不出"絮状星云结构"（纯渐变的破绽就是"太干净"），
   *   AI 生成的星云有真实的纤维走向与颗粒感。
   * → 传了 image 就用它当底图，并**自动关掉 CSS 星云与 CSS 星点**
   *   （两层叠加会显脏，且 AI 图里的星点更真实）。
   */
  image,
  /** 背景图的光位（AI 出图时主体常在某个角落，cover 裁切时靠它取景） */
  imagePosition = "center center",
  /** AI 生成的魔法阵图（有则优先于 CSS SVG 版） */
  circleImage,
  className = "",
}: {
  tint?: string;
  showPrimary?: boolean;
  showCircle?: boolean;
  circleSize?: number;
  circleIntensity?: number;
  circleActive?: boolean;
  image?: string;
  imagePosition?: string;
  circleImage?: string;
  className?: string;
}) {
  const [stars, setStars] = useState<Star[]>([]);
  /** ⚠️ 有 AI 背景图时，不再生成 CSS 星点（避免两层叠加显脏） */
  const useCssStars = !image;

  useEffect(() => {
    // ⚠️ 必须 defer 到客户端 effect：
    //   Next.js 16 预渲染禁用 Math.random（会被烘进静态壳 → 所有页面星图一样）。
    // ⚠️ 有 AI 背景图时跳过（AI 图自带真实星点）。
    if (!useCssStars) return;
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
  }, [useCssStars]);

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

      {/**
       * ---- 层 1.5：AI 星云底图（2026-11-06）----
       * ⚠️ 为什么插在底色之上、其他层之下：
       *   它是"底"，但不能是"最底"（最底是纯色 → 边缘会看到色块接缝）。
       *   放这里 → 上面的暗角/噪点能作用在它身上 → 融进页面。
       *
       * ⚠️ 为什么用 <img> 而不是 CSS background-image：
       *   · <img> 可以加 <picture>/srcset 做响应式（移动端用小图）
       *   · background-image 无法做 srcset
       *   · Next 的 next/image 对背景图没有优化路径
       */}
      {image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{ objectPosition: imagePosition }}
          loading="eager"
          decoding="async"
        />
      )}

      {/**
       * ---- 层 1.6：动态星云流转（2026-11-06）----
       * ⚠️ 用户要求："背景也希望是动态效果的，有星云流转的感觉"。
       *
       * ⚠️ 为什么用 **conic-gradient + 旋转** 做流动：
       *   AI 底图是静态的 → 页面还是"死的"。
       *   而"星云流转"的本质是**色带在缓慢旋转/漂移**。
       *   → conic-gradient 天然是螺旋色带（角度渐变），
       *     旋转它 = 螺旋在转 = 典型的星云流动感。
       *   → 三层不同色相 + 不同周期 → 相对运动 → 看不出规律。
       * ⚠️ 为什么用 mix-blend-mode: screen：
       *   亮色叠加在暗底上才"发光"；normal 混合只会覆盖。
       * ⚠️ 为什么 opacity 这么低（0.10~0.16）：
       *   这是**氛围层**不是主体 → 一点点就够。太亮会盖过 AI 底图的细节。
       */}
      {image && (
        <>
          <div
            className="absolute pointer-events-none"
            style={{
              left: "-18%",
              top: "-12%",
              width: "76%",
              height: "76%",
              borderRadius: "50%",
              background:
                "conic-gradient(from 0deg, rgba(139,92,246,0) 0deg, rgba(139,92,246,0.55) 55deg, rgba(76,29,149,0.28) 140deg, rgba(139,92,246,0) 230deg, rgba(168,85,247,0.42) 300deg, rgba(139,92,246,0) 360deg)",
              filter: "blur(70px)",
              mixBlendMode: "screen",
              opacity: 0.16,
              animation: "nebula-drift-a 76s ease-in-out infinite",
            }}
          />
          <div
            className="absolute pointer-events-none"
            style={{
              right: "-16%",
              bottom: "-14%",
              width: "66%",
              height: "66%",
              borderRadius: "50%",
              background:
                "conic-gradient(from 140deg, rgba(59,130,246,0) 0deg, rgba(59,130,246,0.48) 70deg, rgba(30,64,175,0.22) 170deg, rgba(59,130,246,0) 260deg, rgba(147,51,234,0.34) 320deg, rgba(59,130,246,0) 360deg)",
              filter: "blur(76px)",
              mixBlendMode: "screen",
              opacity: 0.13,
              animation: "nebula-drift-b 92s ease-in-out infinite reverse",
            }}
          />
          {/* 金色的暖光流转（呼应牌背/魔法阵的金） */}
          <div
            className="absolute pointer-events-none"
            style={{
              left: "22%",
              top: "-22%",
              width: "52%",
              height: "52%",
              borderRadius: "50%",
              background:
                "conic-gradient(from 200deg, rgba(212,175,55,0) 0deg, rgba(212,175,55,0.40) 80deg, rgba(212,175,55,0) 190deg, rgba(240,217,138,0.30) 280deg, rgba(212,175,55,0) 360deg)",
              filter: "blur(84px)",
              mixBlendMode: "screen",
              opacity: 0.10,
              animation: "nebula-drift-a 64s ease-in-out infinite reverse",
            }}
          />
        </>
      )}

      {/* ---- 层 2：主光源（顶部中央） ----
           ⚠️ 有 AI 底图时减弱 —— AI 图已经自带光影，
             再叠一层渐变会把它"洗平"。 */}
      {showPrimary && (
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse 70% 50% at 50% -8%, ${tint}, transparent 70%)`,
            opacity: image ? 0.45 : 1,
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
           ⚠️ blur-3xl + 极低透明度 = 有体积的"气体"而不是色块
           ⚠️ 2026-11-06：有 AI 底图时**整层关闭** ——
             AI 星云本身就是有结构的星云，再叠 CSS 色斑会显脏。 */}
      {!image && (
        <>
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
        </>
      )}

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
           ⚠️ 这一层制造"景深"：边缘压暗 → 中心内容浮出来。
           ⚠️ 2026-11-06：有 AI 底图时**加强**中心保护 ——
             AI 图中心可能正好有亮星云，而文字/水晶球就在那儿
             → 需要更深的中心压暗来保证可读性。 */}
      <div
        className="absolute inset-0"
        style={{
          background: image
            ? "radial-gradient(ellipse 68% 58% at 50% 44%, rgba(3,2,8,0.78) 0%, rgba(3,2,8,0.55) 45%, rgba(2,1,6,0.72) 100%)"
            : "radial-gradient(ellipse 75% 65% at 50% 45%, transparent 35%, rgba(2, 1, 6, 0.55) 100%)",
        }}
      />

      {/* ---- 层 8：星象魔法阵（可选）----
           ⚠️ 为什么魔法阵要放在**这个宿主里面**（而不是页面里自己定位）：
             页面级定位（absolute/fixed + 百分比）会因为祖先的 transform /
             filter / backdrop-filter 而偏移（实测三次都跑偏）。
             → 让这个已经是 inset-0 的层做 flex 居中 → 位置永远正确。
           ⚠️ 2026-11-06：优先用 **AI 生成的星盘图**（真实刻蚀质感，
             比 CSS 画的精细几个量级），没有图时才退回 CSS 的 SVG 版本。
           ⚠️ AI 魔法阵必须**很淡**（circleIntensity × 0.3）：
             它在星云上只是"精密仪器"的一层叠加，不能抢主角。 */}
      {showCircle && (
        <div className="absolute inset-0 flex items-center justify-center">
          {circleImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={circleImage}
              alt=""
              className="pointer-events-none select-none"
              style={{
                width: circleSize,
                height: circleSize,
                /**
                 * ⚠️ 2026-11-06：整体再压暗（0.3 → 0.22）。
                 * ⚠️ 为什么要压到这么淡：
                 *   AI 星盘图的黄道符号非常清晰，如果不压暗会**抢主角**
                 *   （用户要的是"淡魔法阵做叠加装饰，不抢戏"）。
                 *   → 靠 opacity + 轻微模糊让它退成"底纹"，
                 *   但轮廓还在（这是"精密仪器"感的关键）。
                 */
                opacity: circleIntensity * 0.22,
                filter: "drop-shadow(0 0 24px rgba(212,175,55,0.20)) blur(0.4px)",
                animation: "astral-spin 220s linear infinite",
              }}
            />
          ) : (
            <AstralCircle size={circleSize} intensity={circleIntensity} active={circleActive} />
          )}
        </div>
      )}
    </div>
  );
}
