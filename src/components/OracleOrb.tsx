"use client";

import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useRef } from "react";

/**
 * 占卜水晶球（2026-11-05 视觉重设计 · 第 3 批 · 首页主视觉）
 *
 * ⚠️⚠️ 为什么首页需要"一个中心物"：
 *   之前首页是"标题 + 一堆选项"，所有元素权重相同 → 视线无处停留。
 *   而"占卜"这件事天然需要一个**视觉锚点**（水晶球 / 牌堆 / 蜡烛）。
 *   → 这个组件就是那个锚点：整页的重心。
 *
 * ⚠️ 为什么是"球"而不是"牌"：
 *   牌面是静态图（78 张里挑一张会显得随意），
 *   而球是**中性的容器** —— 它承载"你要问的事"，不预设答案。
 *   语义上更准确，也更好看。
 *
 * ⚠️ 内部为什么是"星云"而不是纯色：
 *   纯色球 = 塑料感；星云球 = 有内容、有深度、有"在动"的感觉。
 *   → 用多层 radial-gradient + blur 模拟，零 canvas 成本。
 *
 * ⚠️ 鼠标跟随视差：
 *   球体本身微微朝鼠标方向偏移（±6px），内部星云偏移更多（±14px）
 *   → 产生"球在玻璃里"的立体错觉。幅度必须很小，否则显得廉价。
 */
export default function OracleOrb({
  size = 200,
  /** 鼠标跟随的最大偏移（px） */
  parallax = 6,
  className = "",
}: {
  size?: number;
  parallax?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 鼠标位置（归一化 -0.5 ~ 0.5）
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  // 弹簧跟随 → 有"跟随感"而不是"生硬跟随"
  const sx = useSpring(mx, { stiffness: 60, damping: 18, mass: 0.6 });
  const sy = useSpring(my, { stiffness: 60, damping: 18, mass: 0.6 });

  // 内部星云位移（更大 → 视差更强）
  const innerX = useTransform(sx, (v) => v * parallax * 2.2);
  const innerY = useTransform(sy, (v) => v * parallax * 2.2);
  // 高光位置随鼠标反方向微移（模拟光源固定、球在动）
  const glossX = useTransform(sx, (v) => -v * parallax * 0.8);
  const glossY = useTransform(sy, (v) => -v * parallax * 0.8);

  return (
    <motion.div
      ref={ref}
      className={`relative select-none ${className}`}
      style={{ width: size, height: size, x: sx, y: sy }}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        mx.set((e.clientX - r.left) / r.width - 0.5);
        my.set((e.clientY - r.top) / r.height - 0.5);
      }}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      animate={{ scale: [1, 1.015, 1] }}
      transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
    >
      {/* ---- 外层光晕（呼吸） ---- */}
      <div
        className="absolute -inset-10 rounded-full"
        style={{
          background: "radial-gradient(circle, rgba(168,85,247,0.30) 0%, rgba(139,92,246,0.12) 40%, transparent 70%)",
          filter: "blur(18px)",
          animation: "orb-breathe 5.5s ease-in-out infinite",
        }}
      />

      {/* ---- 球体外壳（玻璃质感） ---- */}
      <div
        className="absolute inset-0 rounded-full overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 34% 28%, rgba(196,181,253,0.30) 0%, rgba(88,28,135,0.42) 38%, rgba(12,6,26,0.92) 76%)",
          boxShadow:
            "inset 0 2px 22px rgba(233,213,255,0.28), inset 0 -18px 42px rgba(0,0,0,0.55), 0 0 60px rgba(139,92,246,0.28), 0 12px 46px rgba(0,0,0,0.55)",
          border: "1px solid rgba(196,181,253,0.30)",
        }}
      >
        {/* 内部星云（视差最大） */}
        <motion.div
          className="absolute inset-0"
          style={{ x: innerX, y: innerY }}
        >
          <div
            className="absolute left-[12%] top-[18%] w-[62%] h-[62%] rounded-full opacity-70"
            style={{
              background: "radial-gradient(circle, rgba(216,180,254,0.75) 0%, transparent 68%)",
              filter: "blur(13px)",
            }}
          />
          <div
            className="absolute right-[8%] bottom-[22%] w-[55%] h-[55%] rounded-full opacity-60"
            style={{
              background: "radial-gradient(circle, rgba(59,130,246,0.55) 0%, transparent 70%)",
              filter: "blur(15px)",
            }}
          />
          <div
            className="absolute left-[30%] bottom-[8%] w-[42%] h-[42%] rounded-full opacity-50"
            style={{
              background: "radial-gradient(circle, rgba(217,119,6,0.42) 0%, transparent 72%)",
              filter: "blur(16px)",
            }}
          />
        </motion.div>

        {/* 内部星点 */}
        <div
          className="absolute inset-0 opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(1.4px 1.4px at 22% 32%, rgba(255,255,255,0.9), transparent)," +
              "radial-gradient(1.2px 1.2px at 68% 24%, rgba(255,255,255,0.8), transparent)," +
              "radial-gradient(1.6px 1.6px at 78% 62%, rgba(233,213,255,0.9), transparent)," +
              "radial-gradient(1.1px 1.1px at 34% 72%, rgba(255,255,255,0.75), transparent)," +
              "radial-gradient(1.3px 1.3px at 52% 46%, rgba(255,255,255,0.7), transparent)",
          }}
        />

        {/* 高光（反方向微移 → 玻璃感） */}
        <motion.div
          className="absolute rounded-full"
          style={{
            left: "18%",
            top: "12%",
            width: "42%",
            height: "30%",
            x: glossX,
            y: glossY,
            background:
              "radial-gradient(ellipse at 40% 40%, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.10) 45%, transparent 72%)",
            filter: "blur(5px)",
            transform: "rotate(-28deg)",
          }}
        />

        {/* 内圈边缘光 */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            boxShadow: "inset 0 0 30px rgba(139,92,246,0.22)",
          }}
        />
      </div>

      {/* ---- 环绕符文环（缓慢反向旋转） ----
          ⚠️ 为什么符文用 **SVG path** 而不是字符（✦ ☾ ✧…）：
            ① verify-icons 断言禁止 src/ 出现 U+2600–U+26FF 杂项符号（☾ 就在其中）
            ② 这些字符依赖系统字体，缺字体时是豆腐块
            → 自己画 path，跨平台一致且符合项目约定。 */}
      <motion.div
        className="absolute inset-[-14%]"
        style={{ rotate: 360 }}
        transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
      >
        <svg viewBox="0 0 200 200" className="w-full h-full">
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i * 30 * Math.PI) / 180;
            const r = 92;
            // 六种符文形状循环
            const SHAPES = [
              // 四芒星
              "M0,-5 L1.4,-1.4 L5,0 L1.4,1.4 L0,5 L-1.4,1.4 L-5,0 L-1.4,-1.4 Z",
              // 新月
              "M2,-4.5 A5,5 0 1 0 2,4.5 A3.8,3.8 0 1 1 2,-4.5 Z",
              // 空心菱
              "M0,-4.5 L3.2,0 L0,4.5 L-3.2,0 Z",
              // 沙漏
              "M-3,-4.5 L3,-4.5 L0,0 L3,4.5 L-3,4.5 L0,0 Z",
              // 六芒
              "M0,-5 L1.5,-1.5 L5,0 L1.5,1.5 L0,5 L-1.5,1.5 L-5,0 L-1.5,-1.5 Z M0,-2.2 L2.2,0 L0,2.2 L-2.2,0 Z",
              // 雪花
              "M0,-5 L0,5 M-4.3,-2.5 L4.3,2.5 M-4.3,2.5 L4.3,-2.5",
            ];
            return (
              <g key={i} transform={`translate(${100 + r * Math.cos(a)} ${100 + r * Math.sin(a)})`}>
                <path
                  d={SHAPES[i % SHAPES.length]}
                  fill={i % 2 === 0 ? "rgba(212,175,55,0.55)" : "none"}
                  stroke="rgba(212,175,55,0.55)"
                  strokeWidth="0.7"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}
        </svg>
      </motion.div>

      {/* ---- 底部投影（让球"落"在空间里） ---- */}
      <div
        className="absolute left-1/2 -bottom-6 -translate-x-1/2 w-[62%] h-3 rounded-full"
        style={{
          background: "radial-gradient(ellipse, rgba(139,92,246,0.32) 0%, transparent 70%)",
          filter: "blur(7px)",
        }}
      />
    </motion.div>
  );
}
