"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * 选牌扇面 —— HITL 仪式感核心组件
 *
 * 用户从弧形展开的牌背中凭直觉点选 3 张：
 * - 记录选牌顺序与每张牌的犹豫时长（hover 开始计时）
 * - 选满 3 张自动确认，格式 "id,id,id|dwell,dwell,dwell" 提交给后端
 */

export interface FanCard {
  id: string;
  nameZh: string;
  image: string;
}

export default function CardFan({
  cards,
  count,
  onConfirm,
}: {
  cards: FanCard[];
  count: number;
  onConfirm: (payload: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [dwell, setDwell] = useState<Record<string, number>>({});
  const hoverStart = useRef<Record<string, number>>({});
  const confirmedRef = useRef(false); // 防止选满后重复触发确认

  const pick = (id: string) => {
    if (selected.includes(id) || confirmedRef.current) return;
    const next = [...selected, id];
    setSelected(next);
    if (next.length >= count) {
      confirmedRef.current = true;
      const ids = next.join(",");
      const dwells = next.map((i) => dwell[i] ?? 0).join(",");
      setTimeout(() => onConfirm(`${ids}|${dwells}`), 650); // 等翻牌动画
    }
  };

  const n = cards.length;
  const spread = 150; // 总角度
  const step = n > 1 ? spread / (n - 1) : 0;
  const startAngle = -spread / 2;
  // 弧形参数按容器宽度自适应（固定 420 在 ≤360px 屏会被 main 的 overflow-hidden 裁切，边缘牌不可点）
  const [containerW, setContainerW] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerW(el.clientWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const radius = containerW > 0 ? Math.min(420, containerW * 0.95) : 420;

  return (
    <div className="w-full flex flex-col items-center">
      <p className="text-purple-100/90 text-lg md:text-xl mb-6 tracking-wide" style={{ fontFamily: "'Ma Shan Zheng', serif" }}>
        静心 · 凭直觉选出 {count} 张属于你的命运之牌
      </p>
      <p className="text-purple-300/50 text-xs mb-4">
        已选 {selected.length} / {count} · 你的犹豫与顺序都会成为解读的一部分
      </p>

      <div ref={containerRef} className="relative w-full max-w-3xl h-64 md:h-72 select-none">
        {cards.map((card, i) => {
          const angle = startAngle + step * i;
          const isSel = selected.includes(card.id);
          const selIdx = selected.indexOf(card.id);
          return (
            <motion.button
              key={card.id}
              initial={{ y: 120, opacity: 0, rotate: 0 }}
              animate={{
                y: isSel ? -46 : 0,
                opacity: 1,
                rotate: angle * 0.55,
                x: Math.sin((angle * Math.PI) / 180) * radius * 0.32,
                scale: isSel ? 1.08 : 1,
              }}
              transition={{ delay: i * 0.05, type: "spring", stiffness: 140, damping: 18 }}
              whileHover={{ y: -26, scale: 1.06 }}
              whileTap={{ scale: 0.98 }}
              onMouseEnter={() => { hoverStart.current[card.id] = Date.now(); }}
              onMouseLeave={() => {
                const s = hoverStart.current[card.id];
                if (s) setDwell((d) => ({ ...d, [card.id]: (d[card.id] ?? 0) + (Date.now() - s) }));
              }}
              onClick={() => pick(card.id)}
              className="absolute left-1/2 bottom-0 -ml-[52px] md:-ml-[62px] w-[104px] h-[168px] md:w-[124px] md:h-[200px] rounded-xl glow-border overflow-hidden bg-[#160b26]"
              style={{ transformOrigin: "bottom center" }}
            >
              {/* 牌背图案 */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-14 h-14 md:w-16 md:h-16 rounded-full border-2 border-purple-400/60 flex items-center justify-center rune-breathe">
                  <span className="text-2xl md:text-3xl text-purple-300">✦</span>
                </div>
              </div>
              <div className="absolute inset-2 rounded-lg border border-purple-500/25" />
              {isSel && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="absolute top-2 left-2 w-6 h-6 rounded-full bg-amber-400/90 text-purple-950 text-sm font-bold flex items-center justify-center shadow-[0_0_12px_rgba(251,191,36,0.7)]"
                >
                  {selIdx + 1}
                </motion.div>
              )}
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
