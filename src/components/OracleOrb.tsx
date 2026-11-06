"use client";

import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useRef } from "react";
import TarotCardBack from "@/components/TarotCardBack";

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
      {/* ---- 外层光晕（B 修复：改成**背景径向渐变**，不再用独立圆 div）----
           ⚠️⚠️ 2026-11-05 修复的"戴帽子"问题：
             原来光晕是一个 `absolute -inset-10 rounded-full` 的独立 div，
             而球体是 `overflow-hidden` 的圆 → 光晕的**圆边**在球顶露出一道弧，
             看起来像给球戴了顶帽子（截图实测）。
             → 修法：光晕改成**不裁切的背景径向渐变**（画在球体下方，
               用 box-shadow 的 spread 而不是独立元素），
               这样它就是"从球里透出来的光"，没有边界。 */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(139,92,246,0.34) 0%, rgba(109,40,217,0.16) 42%, transparent 70%)",
          filter: "blur(22px)",
          animation: "orb-breathe 5.5s ease-in-out infinite",
        }}
      />

      {/* ---- 球体外壳（B 修复：提高通透度 + 厚玻璃边缘）----
           ⚠️ 为什么改底色：
             原来 `rgba(88,28,135,0.42)` 是**暗紫**，内部星云（半透明色块）
             叠在上面会被压成灰色 → "灰色玻璃球"（截图实测）。
             → 改成**更亮的紫 + 底部深色衰减**：
               球心通透、底部沉下去 → 才有"发光的宝珠"而不是"灰石头"。 */}
      <div
        className="absolute inset-0 rounded-full overflow-hidden"
        style={{
          background:
            "radial-gradient(circle at 36% 30%, rgba(216,180,254,0.26) 0%, rgba(124,58,237,0.20) 34%, rgba(46,16,101,0.42) 66%, rgba(12,6,26,0.88) 88%)",
          boxShadow:
            // 内侧：底部沉 + 顶部亮（玻璃的"厚"）
            "inset 0 3px 26px rgba(233,213,255,0.30), inset 0 -20px 46px rgba(6,2,16,0.62), " +
            // 外侧：紫光 + 投影
            "0 0 68px rgba(139,92,246,0.34), 0 16px 52px rgba(0,0,0,0.55)",
          border: "1px solid rgba(196,181,253,0.22)",
        }}
      >
        {/* 内部星云（B 修复：改成**有涡旋结构**，不再是三坨纯色糊）----
             ⚠️ 原来三团都是纯 radial-gradient + blur → 放大看只有色块，
               没有"里面有什么"（截图实测）。
             → 改成：中心一团主涡旋 + 环绕的丝状纹路（conic-gradient 模拟旋臂）
               + 两团卫星云 → 有"星系"的结构感。 */}
        <motion.div
          className="absolute inset-0"
          style={{ x: innerX, y: innerY }}
        >
          {/* 主涡旋（conic 渐变 → 旋臂结构） */}
          <div
            className="absolute left-[18%] top-[14%] w-[64%] h-[64%] rounded-full opacity-55"
            style={{
              background:
                "conic-gradient(from 0deg, rgba(216,180,254,0.55) 0deg, transparent 55deg, rgba(167,139,250,0.42) 130deg, transparent 200deg, rgba(129,140,248,0.38) 285deg, transparent 360deg)",
              filter: "blur(11px)",
            }}
          />
          {/* 卫星云（冷 + 暖） */}
          <div
            className="absolute right-[10%] bottom-[20%] w-[46%] h-[46%] rounded-full opacity-45"
            style={{
              background: "radial-gradient(circle, rgba(59,130,246,0.55) 0%, transparent 70%)",
              filter: "blur(14px)",
            }}
          />
          <div
            className="absolute left-[32%] bottom-[10%] w-[34%] h-[34%] rounded-full opacity-38"
            style={{
              background: "radial-gradient(circle, rgba(217,119,6,0.45) 0%, transparent 72%)",
              filter: "blur(15px)",
            }}
          />
        </motion.div>

        {/* ---- 球内主牌（2026-11-06 改版：一张精致牌背居中）----
             ⚠️⚠️ 为什么从「三张公转小牌」改成「一张牌背居中」：
               ① **尺寸是物理限制**：190px 的球里放三张牌，每张只有 ~40px →
                  再怎么调也看不清是牌，只剩"几张脏色块"（用户反馈"还是有点丑"）。
               ② **竞品的答案**（2026-11-06 实测截图）：
                  Tarot Run 的中心是**一张牌背**，牌背本身是极繁曼陀罗纹样；
                  左右各一张倾斜的**线框**牌背暗示牌阵。
                  → 他们的"高级感"来自**单件物品的细节**，不是"塞一堆东西"。
               ③ **焦点**：一张牌居中 = 视线有落点；三张公转 = 视线无处停留。
               → 所以：一张牌背 + 有厚度 + 缓慢呼吸 = 一件被玻璃罩住的物品。 */}
        <CentralCard />

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

        {/* 高光（B 修复：拆成两个 —— 锐主高光 + 弱环境反光）----
             ⚠️ 原来只有一个模糊椭圆 → 球像"贴图"。
             → 真实玻璃有两个光源特征：
                ① 镜面反射（锐、亮、小）
                ② 环境反光（弱、宽、来自环境）→ 用下半球的弧形光带。 */}
        <motion.div
          className="absolute rounded-full"
          style={{
            left: "17%",
            top: "11%",
            width: "34%",
            height: "24%",
            x: glossX,
            y: glossY,
            background:
              "radial-gradient(ellipse at 42% 40%, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0.12) 44%, transparent 70%)",
            filter: "blur(5px)", transform: "rotate(-28deg)",
          }}
        />
        {/* 环境反光（下半球的冷色弧光） */}
        <motion.div
          className="absolute"
          style={{
            left: "8%",
            bottom: "-6%",
            width: "84%",
            height: "52%",
            x: glossX,
            y: glossY,
            borderRadius: "50% 50% 46% 46% / 62% 62% 38% 38%",
            background:
              "radial-gradient(ellipse at 50% 0%, rgba(147,197,253,0.20) 0%, rgba(167,139,250,0.10) 40%, transparent 72%)",
            filter: "blur(9px)",
          }}
        />

        {/**
         * ⚠️ 2026-11-06：原来的「中央问题之核」（球心的脉动白点）已移除。
         *
         * ⚠️ 为什么移除：
         *   球心现在是**牌**的位置 → 白点会打在牌面上，
         *   变成"牌上有个亮点"（像坏点/反光瑕疵），反而脏。
         * → 光核的语义移到**牌下方**（CentralCard 里的光池），
         *   牌"落"在光上 → 更有体积感，且不遮挡主体。
         */}

        {/* 内圈边缘光 */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            boxShadow: "inset 0 0 34px rgba(139,92,246,0.20)",
          }}
        />
      </div>

      {/* ---- 环绕符文环（缓慢反向旋转） ----
          ⚠️ 为什么符文用 **SVG path** 而不是字符（✦ ☾ ✧…）：
            ① verify-icons 断言禁止 src/ 出现 U+2600–U+26FF 杂项符号（☾ 就在其中）
            ② 这些字符依赖系统字体，缺字体时是豆腐块
            → 自己画 path，跨平台一致且符合项目约定。 */}
      <motion.div
        className="absolute inset-[-5%]"
        style={{ rotate: 360 }}
        transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
      >
        <svg viewBox="0 0 200 200" className="w-full h-full">
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i * 30 * Math.PI) / 180;
            const r = 86;
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

      {/* ---- 底部投影（B 修复：加宽 + 变椭圆）----
           ⚠️ 原来 62% × 12px 接近正圆 → 看起来像"另一个小球"，
             而不是落在地面的影子。
           → 改成 78% × 9px 的扁椭圆（影子应该是被压扁的）。 */}
      <div
        className="absolute left-1/2 -bottom-5 -translate-x-1/2 w-[78%] h-[9px] rounded-[50%]"
        style={{
          background: "radial-gradient(ellipse, rgba(139,92,246,0.42) 0%, rgba(88,28,135,0.20) 45%, transparent 72%)",
          filter: "blur(6px)",
        }}
      />
    </motion.div>
  );
}

/**
 * 球内主牌（2026-11-06）
 *
 * ⚠️ 为什么是**一张牌背**（而不是牌面）：
 *   牌面是 78 张具体的牌 → 每张都不同 → 球的内容会"每天不一样"，
 *   而且用户可能认出那张牌（"这是死神牌？"）→ 干扰首页的通用性。
 *   → 牌背是**中性的容器**：它代表"还没揭示的命运"，
 *     而且它的曼陀罗纹样本身就是视觉主体（竞品的做法）。
 *
 * ⚠️ 为什么要有**厚度**（右侧一道亮边 + 底部暗边）：
 *   没有厚度 = 一张贴图；有厚度 = 一张实体卡片躺在球里。
 *   这个差别比任何细节都重要。
 *
 * ⚠️ 为什么**倾斜 -7°**：
 *   完全正面的牌会显得像 UI 元素（证件照），
 *   微微倾斜才有"随意摊在桌上"的感觉。
 */
function CentralCard() {
  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center"
      initial={{ opacity: 0, scale: 0.86 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.1, delay: 0.35, ease: "easeOut" }}
    >
      {/* 呼吸（很慢，幅度很小 —— 大幅度会显得廉价） */}
      <motion.div
        style={{ width: "48%", aspectRatio: "2 / 3", position: "relative" }}
        animate={{ scale: [1, 1.025, 1], y: [0, -2, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* 牌（倾斜 + 有厚度） */}
        <div
          className="absolute inset-0"
          style={{
            transform: "rotate(-7deg) perspective(700px) rotateY(-9deg)",
            transformStyle: "preserve-3d",
            borderRadius: "6px",
            overflow: "hidden",
            boxShadow:
              // 厚度：右侧亮边（受光）
              "inset -3px 0 5px rgba(233,213,255,0.34), " +
              // 底部暗边
              "inset 0 -3px 6px rgba(0,0,0,0.62), " +
              // 悬浮影
              "0 12px 30px rgba(0,0,0,0.62), 0 0 34px rgba(212,175,55,0.20)",
          }}
        >
          <TarotCardBack
            className="w-full h-full"
            image="/images/celestial/card-back.webp"
            imageStyle={{ filter: "saturate(0.92) brightness(0.8)" }}
          />
          {/**
           * ⚠️ 压暗层：牌背在球里会被玻璃"罩住"，
           *   直接显示原色太亮 → 看起来像贴在球面上的贴纸。
           *   ⚠️ 为什么用 multiply 而不是降低 opacity：
           *   opacity 会让**整个牌**变半透明（纹样也淡）；
           *   multiply 只压暗亮度、保留纹样的对比度。
           */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: "rgba(14,8,32,0.5)",
              mixBlendMode: "multiply",
            }}
          />
          {/* 玻璃罩的高光（牌在球里 → 也会被球的高光影响） */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "linear-gradient(118deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.03) 26%, transparent 46%)",
            }}
          />
        </div>

        {/* 牌下方的光池（让牌"落"在光上，而不是浮着） */}
        <motion.div
          className="absolute left-1/2 -bottom-4 -translate-x-1/2 rounded-[50%]"
          style={{
            width: "84%",
            height: "20%",
            background:
              "radial-gradient(ellipse, rgba(212,175,55,0.38) 0%, rgba(139,92,246,0.18) 42%, transparent 72%)",
            filter: "blur(8px)",
          }}
          animate={{ opacity: [0.7, 1, 0.7], scaleX: [0.94, 1.04, 0.94] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>
    </motion.div>
  );
}
