"use client";

/**
 * 塔罗牌背纹样（2026-11-06 视觉重设计 · 第 3 批）
 *
 * ⚠️⚠️ 为什么单独成组件（而不是放在 TarotCardFrame 里）：
 *   牌背现在有**三个**使用方：
 *     ① TarotCardFrame（未揭示的牌）
 *     ② 首页水晶球里的主牌
 *     ③ 运势页的牌背缩略
 *   → 纹样是**资产**，不能复制三份（改一次要改三处）。
 *
 * ⚠️ 2026-11-06：优先使用 **AI 生成的牌背**（真金箔卷草纹 + 中央曼陀罗日轮）。
 *   AI 生成的精细度远超手写 SVG path（金箔的明暗变化、卷草的曲线张力）。
 *   → 但保留 SVG 版作为 fallback（图片未生成/加载失败时不至于空白）。
 *
 * ⚠️ 纹样设计参考（竞品实测截图 2026-11-06）：
 *   Tarot Run 的牌背是**极繁曼陀罗**（几十条同心线 + 放射线 + 装饰卷草），
 *   在深色背景上是整页的视觉主体 —— 它的"高级感"来自纹样的密度，
 *   不是来自颜色。
 *   → 我们做**中等繁复度**版本：
 *     · 双层外框 + 四角卷草角饰
 *     · 中心圆盘（多环 + 刻度）
 *     · 8 芒星（曼陀罗的标志图形）
 *     · 12 段放射线 + 12 星座刻度点
 *     · 深蓝底 + 金线（与我们的紫金品牌一致）
 *
 * ⚠️ 为什么底色用深蓝而不是紫：
 *   我们的品牌是紫，但**牌背**是"物"——它是印刷品，不是界面元素。
 *   深蓝（藏青）牌背是塔罗的传统（韦特牌就是深蓝/黑金），
 *   而且在紫背景上有冷暖对比 → 更立体、更有"物品感"。
 */
export default function TarotCardBack({
  /** 宽度（viewBox 内部用 200×300 坐标，这里只是给容器用） */
  className = "",
  /** 是否显示中央符号（8 芒星） */
  showCore = true,
  /**
   * ⚠️ AI 牌背图路径（传入则优先用它）
   * ⚠️ 为什么做成参数而不是写死：
   *   牌背图在三个使用方里尺寸需求不同（水晶球里要压暗、牌框里要原色），
   *   让调用方决定用哪张 + 怎么叠效果。
   */
  image,
  /** 图片的额外样式（叠暗度等） */
  imageStyle,
}: {
  className?: string;
  showCore?: boolean;
  image?: string;
  imageStyle?: React.CSSProperties;
}) {
  // ⚠️ 有 AI 图 → 渲染图；否则渲染 SVG fallback
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={image} alt="" className={className} style={imageStyle} />
    );
  }
  return <TarotCardBackSvg className={className} showCore={showCore} />;
}

/** 牌背的 SVG 版本（fallback + 也被 TarotCardFrame 直接引用） */
function TarotCardBackSvg({
  className = "",
  showCore = true,
}: {
  className?: string;
  showCore?: boolean;
}) {
  return (
    <svg viewBox="0 0 200 300" className={className} preserveAspectRatio="xMidYMid meet">
      <defs>
        {/* 深蓝底（藏青） */}
        <linearGradient id="tb-bg-v2" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#1a2547" />
          <stop offset="55%" stopColor="#101a35" />
          <stop offset="100%" stopColor="#0a1024" />
        </linearGradient>

        {/* 金线渐变（让边框有金属的明暗变化） */}
        <linearGradient id="tb-gold-v2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f0d98a" />
          <stop offset="40%" stopColor="#d4af37" />
          <stop offset="75%" stopColor="#a8862a" />
          <stop offset="100%" stopColor="#e8c87a" />
        </linearGradient>

        {/* 细密底纹（微弱的放射线阵列，制造"织物质感"） */}
        <pattern id="tb-ray-v2" width="200" height="200" patternUnits="userSpaceOnUse">
          {Array.from({ length: 36 }, (_, i) => {
            const a = (i * 10 * Math.PI) / 180;
            return (
              <line
                key={i}
                x1={100}
                y1={100}
                x2={100 + 100 * Math.cos(a)}
                y2={100 + 100 * Math.sin(a)}
                stroke="rgba(212,175,55,0.06)"
                strokeWidth="0.5"
              />
            );
          })}
        </pattern>
      </defs>

      {/* 底 */}
      <rect width="200" height="300" fill="url(#tb-bg-v2)" />
      <rect width="200" height="300" fill="url(#tb-ray-v2)" />

      {/* ---- 外框：双线 ---- */}
      <rect
        x="7"
        y="7"
        width="186"
        height="286"
        rx="4"
        fill="none"
        stroke="url(#tb-gold-v2)"
        strokeWidth="1.6"
      />
      <rect
        x="12"
        y="12"
        width="176"
        height="276"
        rx="3"
        fill="none"
        stroke="rgba(212,175,55,0.38)"
        strokeWidth="0.6"
      />

      {/* ---- 四角卷草角饰 ---- */}
      {[
        [12, 12, 1, 1],
        [188, 12, -1, 1],
        [12, 288, 1, -1],
        [188, 288, -1, -1],
      ].map(([x, y, sx, sy], i) => (
        <g key={i} transform={`translate(${x} ${y}) scale(${sx} ${sy})`}>
          <path
            d="M0 14 C0 6 6 0 14 0 M3 14 C3 8 8 3 14 3"
            fill="none"
            stroke="rgba(212,175,55,0.62)"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
          <circle cx="17" cy="2" r="1.2" fill="rgba(212,175,55,0.5)" />
        </g>
      ))}

      {/* ---- 中部：曼陀罗主体 ---- */}
      <g transform="translate(100 150)">
        {/* 外圈刻度（60 根短刻度 + 12 根长刻度） */}
        <g>
          {Array.from({ length: 60 }, (_, i) => {
            const a = (i * 6 * Math.PI) / 180;
            const major = i % 5 === 0;
            const r1 = major ? 58 : 61;
            const r2 = 65;
            return (
              <line
                key={i}
                x1={r1 * Math.cos(a)}
                y1={r1 * Math.sin(a)}
                x2={r2 * Math.cos(a)}
                y2={r2 * Math.sin(a)}
                stroke={major ? "rgba(212,175,55,0.72)" : "rgba(212,175,55,0.30)"}
                strokeWidth={major ? 0.9 : 0.5}
              />
            );
          })}
        </g>

        {/* 装饰环（双线 + 虚线） */}
        <circle r="55" fill="none" stroke="rgba(212,175,55,0.55)" strokeWidth="0.8" />
        <circle
          r="49"
          fill="none"
          stroke="rgba(212,175,55,0.42)"
          strokeWidth="0.6"
          strokeDasharray="2 3"
        />
        <circle r="44" fill="none" stroke="rgba(212,175,55,0.34)" strokeWidth="0.5" />

        {showCore && (
          <>
            {/* 8 芒星（两个正方形叠 45°）—— 牌背的标志图形，要够醒目 */}
            <rect
              x="-24"
              y="-24"
              width="48"
              height="48"
              fill="none"
              stroke="rgba(212,175,55,0.62)"
              strokeWidth="1"
            />
            <rect
              x="-24"
              y="-24"
              width="48"
              height="48"
              fill="none"
              stroke="rgba(240,217,138,0.80)"
              strokeWidth="1.1"
              transform="rotate(45)"
            />

            {/* 内圈：细密放射线 */}
            <g>
              {Array.from({ length: 24 }, (_, i) => {
                const a = (i * 15 * Math.PI) / 180;
                return (
                  <line
                    key={i}
                    x1={13 * Math.cos(a)}
                    y1={13 * Math.sin(a)}
                    x2={19 * Math.cos(a)}
                    y2={19 * Math.sin(a)}
                    stroke="rgba(212,175,55,0.40)"
                    strokeWidth="0.45"
                  />
                );
              })}
            </g>

            {/* 中心圆盘 */}
            <circle r="12" fill="#0d1428" stroke="rgba(212,175,55,0.95)" strokeWidth="1.4" />
            <circle r="8.5" fill="none" stroke="rgba(212,175,55,0.62)" strokeWidth="0.7" />
            {/* 中心：四角星 */}
            <path
              d="M0,-7 L1.8,-1.8 L7,0 L1.8,1.8 L0,7 L-1.8,1.8 L-7,0 L-1.8,-1.8 Z"
              fill="rgba(240,217,138,0.98)"
            />
          </>
        )}
      </g>

      {/* ---- 上下小字带（装饰线） ---- */}
      {[
        { y: 34, flip: false },
        { y: 266, flip: true },
      ].map((b, i) => (
        <g key={i} transform={`translate(100 ${b.y})`}>
          <line x1="-52" y1="0" x2="-12" y2="0" stroke="rgba(212,175,55,0.35)" strokeWidth="0.6" />
          <line x1="12" y1="0" x2="52" y2="0" stroke="rgba(212,175,55,0.35)" strokeWidth="0.6" />
          <circle cx="-7" cy="0" r="1.4" fill="none" stroke="rgba(212,175,55,0.5)" strokeWidth="0.6" />
          <circle cx="7" cy="0" r="1.4" fill="none" stroke="rgba(212,175,55,0.5)" strokeWidth="0.6" />
          <path
            d="M0,-4 L2,0 L0,4 L-2,0 Z"
            fill="none"
            stroke="rgba(212,175,55,0.55)"
            strokeWidth="0.6"
          />
        </g>
      ))}
    </svg>
  );
}
