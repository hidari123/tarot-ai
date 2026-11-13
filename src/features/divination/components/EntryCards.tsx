"use client";

import Link from "next/link";
import { motion } from "framer-motion";

/**
 * EntryCards —— 首页的三个入口卡片（2026-11-12 拆分自 src/app/page.tsx）
 *
 * ⚠️⚠️ 为什么单独抽出来：
 *   · 三个入口是**产品的能力展示**（不只是导航）
 *   · 竞品对标：Tarot Run 顶栏有「每日塔罗」，Tarotap 有 5 种运势
 *   · 放在副标题下（而不是右上角）→ 用户刚进站、正准备提问时
 *     看到"今天也有牌"能降低"必须提问才能用"的门槛 ✅
 *
 * ⚠️⚠️ 2026-11-06 对比度修正（用户反馈："背景是紫色的，上面图标文字模块又都是紫色的 对比度太差"）
 *
 * ⚠️ 根因：**紫底 + 紫组件 + 紫文字** = 三者同色系 → 全部糊在一起。
 *   截图实测：入口卡片的 `bg-purple-950/25` 叠在紫背景上几乎看不出边界，
 *   文字 `text-purple-300/40` 更是有字形都看不清。
 *
 * ⚠️ 解法（颜色分工）：
 *   · **背景层**  保持紫色（深空氛围）
 *   · **容器层**  深色实底（近黑紫 rgba(9,5,20,.78)）+ 玻璃模糊 → 有明确边界
 *   · **描边层**  金色（rgba(212,175,55,.28)）→ 与紫底分离
 *   · **图标层**  金色实心纹样 → 视觉焦点
 *   · **文字层**  标题近白（琥珀白）、描述提亮到 68%
 *   → 一句话：**背景紫、容器深、描边金、图标金、文字白**。
 */

/** 三个入口（数据与渲染分离 → 以后加第四个入口只改这里） */
const ENTRIES = [
  {
    href: "/daily",
    img: "/images/celestial/icon-daily.webp",
    title: "今日之牌",
    desc: "今天与你有关的那张牌",
  },
  {
    href: "/fortune",
    img: "/images/celestial/icon-fortune.webp",
    title: "运势专区",
    desc: "每日 · 月 · 季 · 年运",
  },
  {
    href: "/oracle",
    img: "/images/celestial/icon-oracle.webp",
    title: "问神谕",
    desc: "不必抽牌，也能问",
  },
] as const;

export default function EntryCards() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25, duration: 0.6 }}
      className="w-full max-w-2xl z-10 -mt-2 mb-7"
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {ENTRIES.map((e) => (
          <Link
            key={e.href}
            href={e.href}
            className="group relative rounded-2xl border border-[rgba(212,175,55,0.26)] bg-[rgba(9,5,20,0.78)] backdrop-blur-md px-4 py-4 transition-all duration-300 hover:border-[rgba(240,217,138,0.55)] hover:-translate-y-1"
            style={{
              boxShadow:
                "0 8px 30px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.07)",
            }}
          >
            {/* 悬停时的金色边光 */}
            <span
              className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
              style={{
                boxShadow:
                  "0 0 30px rgba(212,175,55,0.32), inset 0 0 20px rgba(212,175,55,0.08)",
              }}
            />
            <div className="flex items-start gap-3">
              {/**
               * ⚠️ 2026-11-06：图标改用 **AI 生成的金质纹样**（月+书 / 轨道 / 眼）。
               *
               * ⚠️⚠️ 为什么**去掉圆圈底**（用户反馈："图标外面还有白色的底色"）：
               *   ① AI 出的图标**本身就是完整的圆形纹样**（月+书 / 星盘 / 眼）
               *      → 再套一个圆圈 = 圆圈里挤一团金色 → 22px 下糊成一团，
               *      边缘的半透明渐变看起来就像"有白底"。
               *   ② 图标放大到 30px → 细节看得清。
               *   → 去掉底圈，直接放图标 + 金色微光。
               */}
              <span className="w-8 h-8 shrink-0 flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={e.img}
                  alt=""
                  className="w-[30px] h-[30px] object-contain"
                  style={{
                    filter:
                      "drop-shadow(0 0 6px rgba(240,217,138,0.55)) drop-shadow(0 0 14px rgba(212,175,55,0.25))",
                  }}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] tracking-[0.12em] text-[rgba(255,248,235,0.96)] group-hover:text-amber-50">
                  {e.title}
                </span>
                <span className="block text-[10px] text-[rgba(203,190,255,0.68)] mt-0.5 leading-snug">
                  {e.desc}
                </span>
              </span>
            </div>
          </Link>
        ))}
      </div>
    </motion.div>
  );
}
