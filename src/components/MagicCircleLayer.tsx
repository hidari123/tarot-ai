"use client";

import AstralCircle from "@/components/AstralCircle";

/**
 * MagicCircleLayer —— 星象魔法阵（独立层 · 2026-11-18）
 *
 * ⚠️⚠️ 为什么从 CelestialBackdrop 里拆出来（用户要求）：
 *   「图层顺序 第一层小女孩 第二层魔法阵 第三层背景 目前顺序还是有问题」
 *
 * ⚠️⚠️ 之前为什么"改了 z-index 还是不对"（实测诊断）：
 *   · 魔法阵在 CelestialBackdrop **内部**（它的子元素）
 *   · 魔法阵的 <img> 是 `position: static` → **没有自己的层叠位置**
 *   · 魔法阵 opacity 0.22 + 女孩 opacity 0.245 → **两层半透明叠加**
 *     → 无论谁在上，阵线都会从女孩身上"渗"出来 ❌
 *
 * ⚠️ 拆出来后的结构（顺序确定，不再靠隐式的兄弟关系）：
 *   ```
 *   <CelestialBackdrop />   ← 背景星云（absolute, z-auto）
 *   <MagicCircleLayer />    ← 魔法阵（absolute, z-0）← 本组件
 *   <WitchOrb />            ← 女孩 + 球（absolute, z-[1]）
 *   <内容 z-10 />
 *   ```
 *   → 魔法阵是**独立元素**，有自己的 z-index → 顺序完全可控 ✅
 *
 * ⚠️⚠️ 定位为什么用 flex 居中（而不是 absolute + 百分比）：
 *   页面级定位会因为祖先的 transform / filter / backdrop-filter 而偏移
 *   （实测三次都跑偏）→ 用 inset-0 的层做 flex 居中 → 位置永远正确 ✅
 *
 * ⚠️ opacity 说明：
 *   · 0.22 是"淡魔法阵做叠加装饰、不抢戏"的设计值（用户确认过亮度合适）
 *   · 现在魔法阵在**女孩之下**（不是半透明叠加）→ 0.22 就够 ✅
 */
export default function MagicCircleLayer({
  /** 直径（px） */
  size = 620,
  /** 强度（0-1）→ 映射到最终 opacity */
  intensity = 0.72,
  /** 是否"激活"（占卜开始时点亮） */
  active = false,
  /** AI 生成的星盘图（有则优先于 CSS SVG 版） */
  image,
  className = "",
}: {
  size?: number;
  intensity?: number;
  active?: boolean;
  image?: string;
  className?: string;
}) {
  return (
    <div
      className={`absolute inset-0 z-0 flex items-center justify-center pointer-events-none ${className}`}
      aria-hidden
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          className="pointer-events-none select-none"
          style={{
            width: size,
            height: size,
            /**
             * ⚠️ 2026-11-06：整体压暗（0.3 → 0.22）
             * ⚠️ AI 星盘图的黄道符号非常清晰，不压暗会**抢主角**
             *   → 靠 opacity + 轻微模糊让它退成「底纹」，但轮廓还在
             *   （这是「精密仪器」感的关键）
             */
            opacity: intensity * 0.22,
            filter: "drop-shadow(0 0 24px rgba(212,175,55,0.20)) blur(0.4px)",
            animation: "astral-spin 220s linear infinite",
          }}
        />
      ) : (
        <AstralCircle size={size} intensity={intensity} active={active} />
      )}
    </div>
  );
}
