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

        {/* ---- A 轻量版：球内三张微型悬浮牌（A 方案的核心）----
             ⚠️ 为什么球里要放牌：
               球本身是"通用"隐喻（水晶球可以装任何东西），
               而我们是**塔罗**产品 —— 球里浮着三张牌，一眼就知道这是塔罗，
               不用任何文字解释。
             ⚠️ 为什么"三张"：
               对应我们的三张牌牌阵（过去/当下/未来）→ 语义一致。
             ⚠️ 为什么极小（26px）且半透明：
               它们是**暗示**不是主角 —— 主角是球的光影。
               太大就变成"三张小图片贴在球上"，反而假。 */}
        <FloatingCards />

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

        {/* ---- A 轻量版：中央"问题之核"（脉动光点）----
             ⚠️ 为什么需要：
               球需要一个**焦点**，否则视线无处停留（"空"）。
               而"脉动"= 活的 = 有东西在里面运行。
             ⚠️ 为什么放中心而不是别的位置：
               中心 = 球的重心 → 视觉焦点；且与魔法阵内核重叠时
               会形成"阵中之心"的呼应。 */}
        <motion.div
          className="absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: 26,
            height: 26,
            marginLeft: -13,
            marginTop: -13,
            background:
              "radial-gradient(circle, rgba(255,255,255,0.92) 0%, rgba(216,180,254,0.55) 32%, rgba(139,92,246,0.18) 62%, transparent 78%)",
            filter: "blur(0.5px)",
          }}
          animate={{ scale: [1, 1.22, 1], opacity: [0.85, 1, 0.85] }}
          transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
        />

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
 * 球内三张微型悬浮牌（A 轻量版 · 2026-11-05）
 *
 * ⚠️ 为什么用 **SVG** 而不是绝对定位的 div：
 *   百分比 translate 相对的是**元素自身尺寸**（牌的宽/高），
 *   而轨道半径是相对**球直径**的 → 两者单位不同，
 *   用 div 做轨道必然算不准（实测：三张牌全挤在球心附近）。
 *   → 改成 SVG：视口 100×100，轨道半径直接用 viewBox 单位 → 精确。
 *
 * ⚠️ 为什么用**固定的牌面图**（而非随机）：
 *   球是首页首屏 —— 每次刷新显示不同的牌会让人以为"变了"，
 *   而且我们**没有**为球做"每日牌"的语义。
 *   → 固定三张经典的牌（愚人/女祭司/世界），稳定且有辨识度。
 *
 * ⚠️ 为什么是**公转**而非静止：
 *   静止的东西会被当成"背景图"；缓慢公转会被当成"活的"。
 *   公转周期必须**很长**（26 秒一轮）—— 快了会显得廉价。
 *
 * ⚠️ 为什么牌要**半透明 + 有景深**（远的小而暗）：
 *   球是玻璃，里面的东西应该被玻璃"罩住" → 有雾化感。
 */
function FloatingCards() {
  /** 三张牌的固定图（public/images/cards 下的经典牌） */
  const CARDS = [
    { src: "/images/cards/Fool.jpg", angle: -90 },
    { src: "/images/cards/High_Priestess.jpg", angle: 30 },
    { src: "/images/cards/World.jpg", angle: 150 },
  ];
  /** 轨道半径（viewBox 单位，球半径 = 50） */
  const R = 27;
  /** 牌的宽（viewBox 单位） */
  const CARD_W = 15;

  return (
    <motion.svg
      className="absolute inset-0 w-full h-full"
      viewBox="0 0 100 100"
      animate={{ rotate: 360 }}
      transition={{ duration: 26, repeat: Infinity, ease: "linear" }}
      style={{ transformOrigin: "50% 50%" }}
    >
      {CARDS.map((c, i) => {
        const a = (c.angle * Math.PI) / 180;
        const x = 50 + R * Math.cos(a);
        const y = 50 + R * Math.sin(a);
        // 景深：牌在"背面"时（角度 90~270）更暗更小
        const depth = (Math.sin(a) + 1) / 2; // 0=后 1=前
        const scale = 0.72 + depth * 0.38;
        const opacity = 0.32 + depth * 0.55;
        const h = CARD_W * 1.5;
        return (
          <g key={i} transform={`translate(${x} ${y}) rotate(${c.angle + 90}) scale(${scale})`}>
            {/* 牌（金边 + 微光） */}
            <rect
              x={-CARD_W / 2}
              y={-h / 2}
              width={CARD_W}
              height={h}
              rx="0.8"
              fill="#0d0720"
              stroke="rgba(212,175,55,0.75)"
              strokeWidth="0.4"
              opacity={opacity}
            />
            {/* 牌面图（用 image 元素） */}
            <image
              href={c.src}
              x={-CARD_W / 2 + 0.3}
              y={-h / 2 + 0.3}
              width={CARD_W - 0.6}
              height={h - 0.6}
              preserveAspectRatio="xMidYMid slice"
              opacity={opacity}
              clipPath="inset(0 round 0.5px)"
            />
            {/* 背面的牌要压暗（让景深更明显） */}
            {depth < 0.45 && (
              <rect
                x={-CARD_W / 2}
                y={-h / 2}
                width={CARD_W}
                height={h}
                rx="0.8"
                fill="rgba(10,4,24,0.55)"
                opacity={0.45 - depth * 0.45}
              />
            )}
          </g>
        );
      })}
    </motion.svg>
  );
}
