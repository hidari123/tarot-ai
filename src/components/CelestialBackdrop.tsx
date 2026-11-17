"use client";

import { useEffect, useState } from "react";
import AstralCircle from "@/components/AstralCircle";
import NebulaDrift from "@/components/NebulaDrift";

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
  /**
   * ⚠️ 流动星云图（2026-11-13 · 方案 A）
   * ⚠️ 传了它就用**流动星云**替代静态底图（image 失效）
   * ⚠️ 为什么替代而不是叠加：
   *   · 两层星云叠加会显脏（层 1.6 的注释里早就写过这条）❌
   *   · 流动星云本身就是完整的背景 → 直接替代 ✅
   */
  flowImage,
  /** 流动星云的单段像素宽度（= 素材宽的一半） */
  flowSegWidth = 1920,
  /** 流动星云周期（秒） */
  flowDuration = 90,
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
  flowImage?: string;
  flowSegWidth?: number;
  flowDuration?: number;
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
      {/**
       * ---- 层 1.5：流动星云（2026-11-13 · 方案 A）----
       * ⚠️ 用户要求："背景我想要星云流动的感觉"
       *
       * ⚠️⚠️ 为什么用 NebulaDrift 替代静态底图（而不是叠加）：
       *   · 两层星云叠加会显脏（见层 1.6 的注释）❌
       *   · 流动星云本身就是完整背景 → 直接替代静态图 ✅
       *
       * ⚠️ 实现要点：
       *   · 素材 = AI 星云图 + 水平镜像拼成的长图（可无缝平铺）
       *   · background-size: cover → 永远铺满，无黑边（同静态图）
       *   · background-position: 0% → -50% → 走完一段 → 无缝循环
       *   · 周期 90 秒 + ease-in-out alternate → 像呼吸，不像传送带
       */}
      {flowImage ? (
        <NebulaDrift
          showStars
          starDensity={3.4}
          layers={[
            {
              src: flowImage,
              segWidth: flowSegWidth,
              duration: flowDuration,
              alpha: 1,
              /**
               * ⚠️ 亮度：静态底图原来用 brightness(1.28)
               * · 但那张图本身偏暗 → 1.28 提亮
               * · 新素材（粉紫纱幕）本身偏亮 → 反而要压暗
               * · 0.55 让它退成底纹，配合下面的中心挖空 → 不抢内容 ✅
               */
              brightness: 0.44,
              stars: true,
              /**
               * ⚠️⚠️ 中心挖空（方案 B · 2026-11-13）
               * ⚠️ 用户反馈："底色是粉色的这个动态的移动的背景
               *    上面的小女孩和旋转的占卜的那个圆盘 都变得不清晰了"
               *
               * ⚠️ 为什么需要：
               *   · 旧静态背景的构图 = 中心深色空场 + 外围星云
               *     → 人物和魔法阵落在空场里 → 轮廓清晰 ✅
               *   · 流动星云满屏弥散 → 人物周围没有暗区 → 剪影消失 ❌
               *   → 在中心挖一个椭圆暗区 → 恢复原有构图逻辑 ✅
               *
               * ⚠️ 参数怎么定的：
               *   · x=50% y=34% → 人物在页面上半部，洞要偏上
               *   · w=52% h=46% → 覆盖魔法阵直径（620px @1200 屏 ≈ 52%）
               *   · inner=0.88 → 中心几乎全黑（接近旧背景的暗度）
               *   · core=42% → 中心 42% 半径内保持全黑（人物全身都在里面）
               *   · outer=0.25 → 边缘保留 25% 星云（流动感还在）
               */
              centerHole: {
                w: 52,
                h: 46,
                x: 50,
                y: 34,
                inner: 0.88,
                core: 42,
                outer: 0.25,
              },
            },
          ]}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image!}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          style={{
            objectPosition: imagePosition,
            /**
             * ⚠️⚠️ 2026-11-10：给底图提亮（用户反馈「今日之牌没有背景图」）
             * ⚠️ 为什么需要：
             *   AI 生成的底图本身就暗（bg-daily 平均亮度只有 rgb(31,14,38)），
             *   再叠暗角/噪点/辅光 → 中心几乎全黑 → 用户看不到背景。
             * ⚠️ 为什么用 CSS filter 而不是重新生成图：
             *   · 重新生成要多花一次 API 调用 + 抽卡
             *   · filter 是一行参数，随时可调 → 便于对比
             * ⚠️ 为什么亮度提到 1.28 而不是更高：
             *   · 太亮会让星云的层次糊掉（都推到接近白）
             *   · 1.28 让暗部抬起来、亮部仍保留细节
             */
            filter: "brightness(1.28) saturate(1.08)",
          }}
          loading="eager"
          decoding="async"
        />
      )}

      {/**
       * ---- 层 1.6：动态星云流转（2026-11-06）----
       * ⚠️ 用户要求："背景也希望是动态效果的，有星云流转的感觉"。
       *
       * ⚠️⚠️ 为什么之前"没出现"（用户反馈）：
       *   ① 用了 `nebula-drift-a/b` —— 那两个 keyframes 只有**平移**（±5%），
       *      肉眼几乎看不出变化；而且它们是给纯色模糊斑设计的。
       *   ② opacity 只有 0.10~0.16 → 太淡。
       *   ③ conic-gradient 的螺旋不**旋转**就等于静态。
       * → 改用专用的 `celestial-swirl-*`（真的旋转）+ 提高可见度。
       *
       * ⚠️ 为什么用 mix-blend-mode: screen：
       *   亮色叠加在暗底上才"发光"；normal 混合只会覆盖。
       * ⚠️ 为什么三个周期互质（97 / 131 / 163 秒）：
       *   相同周期 → 几团云会周期性地对齐 → 看出规律。
       *   互质 → 永不重复 → 看起来是真实的天体漂移。
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
                "conic-gradient(from 0deg, rgba(139,92,246,0) 0deg, rgba(139,92,246,0.75) 55deg, rgba(76,29,149,0.40) 140deg, rgba(139,92,246,0) 230deg, rgba(168,85,247,0.58) 300deg, rgba(139,92,246,0) 360deg)",
              filter: "blur(64px)",
              mixBlendMode: "screen",
              opacity: 0.30,
              animation: "celestial-swirl-a 97s linear infinite",
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
                "conic-gradient(from 140deg, rgba(59,130,246,0) 0deg, rgba(59,130,246,0.68) 70deg, rgba(30,64,175,0.34) 170deg, rgba(59,130,246,0) 260deg, rgba(147,51,234,0.48) 320deg, rgba(59,130,246,0) 360deg)",
              filter: "blur(70px)",
              mixBlendMode: "screen",
              opacity: 0.26,
              animation: "celestial-swirl-b 131s linear infinite",
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
                "conic-gradient(from 200deg, rgba(212,175,55,0) 0deg, rgba(212,175,55,0.58) 80deg, rgba(212,175,55,0) 190deg, rgba(240,217,138,0.44) 280deg, rgba(212,175,55,0) 360deg)",
              filter: "blur(78px)",
              mixBlendMode: "screen",
              opacity: 0.20,
              animation: "celestial-swirl-c 163s linear infinite",
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

           ⚠️⚠️⚠️ 2026-11-10 修正（用户反馈「今日之牌点进去依旧没有背景图」）：
           *   旧版在有 AI 底图时用 `rgba(3,2,8,0.78)` 压**中心** →
           *   而底图本身就很暗（bg-daily 平均亮度只有 rgb(31,14,38)）→
           *   叠完中心几乎全黑 → **用户看不到背景图**。
           *
           * ⚠️ 为什么"压中心"本来是错的：
           *   暗角（vignette）的作用是**收边**，不是压中心。
           *   压中心 = 把底图最漂亮的部分（星云）藏起来。
           *   → 中心改成**透明**，只压四周 → 底图原样透出。
           *
           * ⚠️ 文字可读性怎么办：
           *   由**内容面板自己的半透明底**保证（CelestialPanel 已有），
           *   而不是靠压暗背景图 —— 压背景会让整页发闷。
           */}
      <div
        className="absolute inset-0"
        style={{
          background: image
            ? "radial-gradient(ellipse 78% 68% at 50% 45%, rgba(3,2,8,0) 42%, rgba(3,2,8,0.30) 78%, rgba(2,1,6,0.62) 100%)"
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
                 *
                 * ⚠️⚠️ 2026-11-13（方案 C）：流动星云模式下**提亮**
                 * ⚠️ 用户反馈："旋转的占卜的那个圆盘 都变得不清晰了"
                 * ⚠️ 原因：
                 *   · 静态背景时，魔法阵是叠在**深色空场**上 → 淡金线也看得清
                 *   · 流动星云满屏明亮 → 淡金线（opacity 0.16）和亮背景的对比极低 ❌
                 *   → 有了中心挖空（方案 B）后背景已经暗下来了 → 可以提亮 ✅
                 * ⚠️ 提亮幅度：0.22 → 0.34（不回到 0.3 的老值，避免抢戏）
                 */
                opacity: circleIntensity * (flowImage ? 0.34 : 0.22),
                filter: flowImage
                  ? "drop-shadow(0 0 26px rgba(212,175,55,0.34)) blur(0.3px)"
                  : "drop-shadow(0 0 24px rgba(212,175,55,0.20)) blur(0.4px)",
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
