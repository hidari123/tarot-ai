"use client";

/**
 * 星象魔法阵（2026-11-05 视觉重设计 · 第 1 批）
 *
 * ⚠️⚠️ 为什么从「3 个 CSS 圆圈」换成真 SVG：
 *   原来的实现是三个 `rounded-full` + border（其中一个 border-dashed）。
 *   那东西看起来就是"三个圈"——没有刻度、没有符号、没有结构，
 *   是"基础图形"的典型代表。
 *   → 真 SVG 能画出：刻度线、八芒星、星座符号环、元素符号，
 *     而且它们**共用一个中心**（构成"阵"而不是"圈"）。
 *
 * ⚠️ 结构设计（从外到内）：
 *   L1 外环    —— 极细实线 + 每 5° 一根长刻度（每 30° 加粗）
 *   L2 星座环  —— 12 个星座符号，等角分布
 *   L3 中环    —— 虚线（每段短、间隔密 → 像刻度盘）
 *   L4 元素环  —— 火/水/风/土 四符号，四方位置
 *   L5 八芒星  —— 两个正方形叠加 45°（这是"魔法阵"最标志性的图形）
 *   L6 内核    —— 实心微光圆点（= 光源本身）
 *
 * ⚠️ 旋转策略：每层不同方向、不同速度（互质周期 → 永不重复）
 *   ⚠️ 但**内核不转** —— 它是光源，转了会晕。
 *
 * ⚠️ 为什么用 SVG 而不是 canvas：
 *   SVG 是 DOM → 可以被 CSS 动画驱动（GPU 合成，零 JS），
 *   且矢量在任意分辨率下都清晰（canvas 要处理 devicePixelRatio）。
 */

import { useMemo } from "react";

/**
 * 十二星座符号
 *
 * ⚠️ 为什么用 **SVG path** 而不是字符（♈♉♊…）：
 *   这些字符依赖系统有"星象符号"字体（Windows 有、Linux/macOS 常常没有）
 *   → 缺字体时渲染成**豆腐块**（截图实测：整圈都是方框）。
 *   → 自己画 SVG path，跨平台 100% 一致。
 *   图形取各星座最标志性的元素（牡羊的角、金牛的圆、狮子的鬃…）。
 *   坐标系：每个符号画在 (-7..7, -7..7) 的小方框内。
 */
const ZODIAC_PATHS: string[] = [
  // 白羊：两只角 + 头
  "M-6,-6 L-3,-2 M6,-6 L3,-2 M-3,-2 L3,-2 M-3,-2 L-3,3 M3,-2 L3,3 M-3,3 L3,3",
  // 金牛：横头 + 双角
  "M-6,6 L6,6 M-4,6 L-4,-2 M4,6 L4,-2 M-4,-2 L4,-2 M-7,-4 L-4,-2 M7,-4 L4,-2",
  // 双子：双柱 + 横梁
  "M-4,6 L-4,-6 M4,6 L4,-6 M-6,-6 L6,-6 M-4,-1 L4,-1",
  // 巨蟹：双螯 + 身
  "M-6,-5 C-6,-8 -2,-8 -2,-5 M2,-5 C2,-8 6,-8 6,-5 M-4,-5 L-4,3 L4,3 L4,-5 M-4,0 L-6,2 M4,0 L6,2",
  // 狮子：鬃毛轮廓
  "M-6,-4 L-4,-6 L-1,-5 L2,-7 L5,-5 L6,-2 L4,0 L5,4 L2,6 L-2,6 L-5,4 L-4,0 Z",
  // 处女：麦穗
  "M0,7 L0,-6 M0,-6 L-3,-2 M0,-6 L3,-2 M0,-2 L-2,2 M0,-2 L2,2",
  // 天秤：横梁 + 双盘
  "M-7,-4 L7,-4 M0,-4 L0,6 M-7,-4 L-4,1 L-10,1 Z M7,-4 L4,1 L10,1 Z",
  // 天蝎：螯 + 尾
  "M-4,-6 L-4,4 L0,5 L4,3 L3,-1 L5,-5 M-4,-6 L-6,-3",
  // 人马：弓 + 箭
  "M-7,6 L7,-6 M-2,-3 L6,-6 M2,3 L-6,6 M-4,-1 C-2,1 0,2 2,2",
  // 摩羯：折角
  "M-6,6 L-2,2 L2,3 L5,-3 L1,-6 M-2,2 L-4,-3",
  // 水瓶：波浪 + 盖
  "M-6,0 C-4,-2 -2,2 0,0 C2,-2 4,2 6,0 M-5,5 L5,5 M-4,5 L-4,2 M4,5 L4,2",
  // 双鱼：双弧 + 绳
  "M-6,-4 C-2,-6 2,-2 6,-4 M-6,4 C-2,6 2,2 6,4 M-7,0 L7,0",
];

/**
 * 四元素符号（SVG path，坐标 -7..7）
 * ⚠️ 同样不用 Unicode 字符（🜂 等）—— 字体缺失时是豆腐块（截图实测）。
 */
const ELEMENT_PATHS: string[] = [
  // 火（上三角）
  "M0,-7 L7,5 L-7,5 Z",
  // 水（双波）
  "M-7,-3 C-3,-3 -3,2 0,2 C3,2 3,-3 7,-3 M-7,3 C-3,3 -3,7 0,7 C3,7 3,3 7,3",
  // 风（双弧）
  "M-7,-3 C-3,-8 4,-6 7,-1 M-7,3 C-3,8 4,6 7,1",
  // 土（下三角）
  "M0,7 L7,-5 L-7,-5 Z",
];

export default function AstralCircle({
  /** 直径（px） */
  size = 900,
  /** 强度 0~1（控制整体不透明度） */
  intensity = 1,
  /** 是否"激活"（占卜进行中 → 亮起） */
  active = false,
  className = "",
}: {
  size?: number;
  intensity?: number;
  active?: boolean;
  className?: string;
}) {
  const c = size / 2;

  /** 外环刻度线：每 5° 一根，30° 的更长更亮 */
  const ticks = useMemo(() => {
    const out: Array<{ x1: number; y1: number; x2: number; y2: number; major: boolean }> = [];
    const rOuter = c * 0.97;
    const rInner = c * 0.9;
    const rInnerMajor = c * 0.865;
    for (let i = 0; i < 72; i++) {
      const angle = (i * 5 * Math.PI) / 180;
      const major = i % 6 === 0;
      out.push({
        x1: c + rInner * Math.cos(angle),
        y1: c + rInner * Math.sin(angle),
        x2: c + (major ? rInnerMajor : rOuter) * Math.cos(angle),
        y2: c + (major ? rInnerMajor : rOuter) * Math.sin(angle),
        major,
      });
    }
    return out;
  }, [c]);

  /** 中环的短虚线：每 2° 一段 */
  const dashes = useMemo(() => {
    const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const r = c * 0.74;
    const len = c * 0.028;
    for (let i = 0; i < 180; i++) {
      const a = (i * 2 * Math.PI) / 180;
      out.push({
        x1: c + r * Math.cos(a),
        y1: c + r * Math.sin(a),
        x2: c + (r + len) * Math.cos(a),
        y2: c + (r + len) * Math.sin(a),
      });
    }
    return out;
  }, [c]);

  const op = (base: number) => base * intensity * (active ? 1.7 : 1);

  return (
    <div
      /**
       * ⚠️⚠️⚠️ 2026-11-05：定位方式的**三次修正**（都是截图实测发现的）
       *
       * ① `absolute + left:50% + translate(-50%,-50%)`
       *    → 相对**整个文档**（首页很长）→ 魔法阵落到页面中下部，
       *      刻度环横穿内容区。
       * ② `fixed + left:50% + translate(-50%,-50%)`
       *    → 祖先若有 transform/filter/backdrop-filter，
       *      fixed 的定位上下文会变成那个祖先 → 偏移到左侧。
       *      （截图实测：魔法阵跑到了页面左边三分之一处）
       * ③ `fixed + inset:0 + flex 居中`
       *    → 同样受"祖先有 transform"影响（fixed 变成了 absolute 的行为）。
       *
       * ⚠️ 最终解法：**不自己定位**。
       *   魔法阵应该由**宿主容器**（CelestialBackdrop，它已经是 inset-0 的
       *   absolute 层）来定位 → 宿主给它 `absolute inset-0 flex items-center
       *   justify-center`，魔法阵只负责画自己。
       *   → 这样魔法阵的位置完全由宿主的盒子决定，与视口/文档无关。
       */
      className={`pointer-events-none select-none ${className}`}
      style={{
        width: size,
        height: size,
        position: "relative",
        flexShrink: 0,
      }}
      aria-hidden
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          {/* 径向渐变：让环有"发光"而不是"线条" */}
          <radialGradient id="ac-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(240,217,138,0.55)" />
            <stop offset="45%" stopColor="rgba(212,175,55,0.16)" />
            <stop offset="100%" stopColor="rgba(212,175,55,0)" />
          </radialGradient>
          <filter id="ac-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* ---- 核心光晕（不旋转） ---- */}
        <circle cx={c} cy={c} r={c * 0.55} fill="url(#ac-core)" opacity={op(0.9)} />

        {/* ---- L1 外环 + 刻度（顺时针，最慢） ---- */}
        <g
          className="astral-spin"
          style={{ transformOrigin: `${c}px ${c}px` }}
        >
          <circle
            cx={c}
            cy={c}
            r={c * 0.935}
            fill="none"
            stroke="rgba(212,175,55,0.22)"
            strokeWidth="1"
          />
          {ticks.map((t, i) => (
            <line
              key={i}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.major ? "rgba(212,175,55,0.42)" : "rgba(212,175,55,0.22)"}
              strokeWidth={t.major ? 1.4 : 0.8}
            />
          ))}
        </g>

        {/* ---- L2 星座符号环（逆时针） ---- */}
        <g
          className="astral-spin-reverse"
          style={{ transformOrigin: `${c}px ${c}px` }}
        >
          {ZODIAC_PATHS.map((d, i) => {
            const angle = (i * 30 * Math.PI) / 180 - Math.PI / 2;
            const r = c * 0.845;
            const x = c + r * Math.cos(angle);
            const y = c + r * Math.sin(angle);
            // 让符号"正立"朝外（径向对齐），更像刻度盘
            const rot = (i * 30 + 90).toString();
            return (
              <g key={i} transform={`translate(${x} ${y}) rotate(${rot})`}>
                <path
                  d={d}
                  transform="scale(1.15)"
                  fill="none"
                  stroke="rgba(212,175,55,0.50)"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            );
          })}
        </g>

        {/* ---- L3 中环虚线（顺时针，中速） ---- */}
        <g
          className="astral-spin-mid"
          style={{ transformOrigin: `${c}px ${c}px` }}
        >
          <circle
            cx={c}
            cy={c}
            r={c * 0.7}
            fill="none"
            stroke="rgba(212,175,55,0.18)"
            strokeWidth="1"
          />
          {dashes.map((d, i) => (
            <line
              key={i}
              x1={d.x1}
              y1={d.y1}
              x2={d.x2}
              y2={d.y2}
              stroke="rgba(240,217,138,0.20)"
              strokeWidth="1"
            />
          ))}
        </g>

        {/* ---- L4 元素符号（不动） ---- */}
        {ELEMENT_PATHS.map((d, i) => {
          const angle = (i * 90 * Math.PI) / 180 + Math.PI / 4;
          const r = c * 0.6;
          const x = c + r * Math.cos(angle);
          const y = c + r * Math.sin(angle);
          return (
            <g key={i} transform={`translate(${x} ${y})`}>
              <path
                d={d}
                transform="scale(1.25)"
                fill="none"
                stroke="rgba(240,217,138,0.38)"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          );
        })}

        {/* ---- L5 八芒星（逆时针） ----
             ⚠️ 两个正方形叠加 45° = 标准的"魔法阵"八芒星 */}
        <g
          className="astral-spin-slow"
          style={{ transformOrigin: `${c}px ${c}px` }}
        >
          <rect
            x={c - c * 0.4}
            y={c - c * 0.4}
            width={c * 0.8}
            height={c * 0.8}
            fill="none"
            stroke="rgba(212,175,55,0.18)"
            strokeWidth="1"
            transform={`rotate(45 ${c} ${c})`}
          />
          <rect
            x={c - c * 0.4}
            y={c - c * 0.4}
            width={c * 0.8}
            height={c * 0.8}
            fill="none"
            stroke="rgba(212,175,55,0.12)"
            strokeWidth="1"
            transform={`rotate(0 ${c} ${c})`}
          />
        </g>

        {/* ---- L6 内核光点（不转） ----
             ⚠️ 2026-11-05：内核从"实心亮白点"改成"空心微光环"——
               首页已有水晶球做视觉中心，魔法阵内核再是个白球会与之打架
               （截图实测：中央两个亮点互相竞争）。
               → 改为低透明度的空心圆 + 极淡的填充，让它退到背景层。 */}
        <circle
          cx={c}
          cy={c}
          r={c * 0.035}
          fill="rgba(240,217,138,0.34)"
          filter="url(#ac-glow)"
          opacity={op(0.7)}
        />
        <circle cx={c} cy={c} r={c * 0.075} fill="none" stroke="rgba(240,217,138,0.20)" strokeWidth="1" />
      </svg>
    </div>
  );
}
