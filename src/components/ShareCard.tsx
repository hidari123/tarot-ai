"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * 分享卡片生成器 —— Canvas 合成：
 *   星空背景 + 牌面（正/逆位旋转）+ 牌名/位置 + 问题摘要 + 结论一句话 + 落款
 *
 * 产出 1080×1620 竖版 PNG（适配微信/小红书分享），
 * 浏览器本地渲染，无服务端参与（隐私安全 + 零成本）。
 */

export interface ShareCardData {
  question: string;
  cards: Array<{ nameZh: string; image: string; reversed: boolean; pos: string }>;
  /** 解读的结论一句话（取解读末段或首段摘要） */
  summary: string;
  personaName?: string;
  sessionId?: string;
}

const W = 1080;
const H = 1620;

/** 生成深紫渐变星空背景 + 星点 */
function paintBackground(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#1a0b2e");
  g.addColorStop(0.5, "#16081f");
  g.addColorStop(1, "#0b0514");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 星点（伪随机固定种子，保证同会话出图一致）
  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 160; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const r = rand() * 1.8 + 0.3;
    const a = rand() * 0.7 + 0.15;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(220, 210, 255, ${a.toFixed(2)})`;
    ctx.fill();
  }
}

/** 加载图片（跨域同源无碍），失败返回 null */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** 截断文本到指定宽度 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxWidth) {
      lines.push(line);
      line = ch;
      if (lines.length >= maxLines) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines;
}

export async function renderShareCard(data: ShareCardData): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  paintBackground(ctx);

  /* ---- 标题 ---- */
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(233, 213, 255, 0.95)";
  ctx.font = "600 52px 'Ma Shan Zheng', 'Noto Serif SC', serif";
  ctx.fillText("✦ 命运之卷 ✦", W / 2, 140);

  /* ---- 问题 ---- */
  ctx.font = "400 34px 'Noto Sans SC', sans-serif";
  ctx.fillStyle = "rgba(196, 181, 253, 0.85)";
  const q = ellipsize(ctx, `「${data.question}」`, W - 200);
  ctx.fillText(q, W / 2, 210);

  /* ---- 牌区 ---- */
  const n = data.cards.length;
  const cardW = n <= 1 ? 260 : Math.min(240, (W - 320) / n);
  const cardH = cardW * 1.6;
  const gap = n > 1 ? Math.min(40, (W - 2 * 80 - n * cardW) / Math.max(n - 1, 1)) : 0;
  const totalW = n * cardW + (n - 1) * gap;
  const startX = (W - totalW) / 2;
  const cardY = 300;

  for (let i = 0; i < n; i++) {
    const c = data.cards[i];
    const x = startX + i * (cardW + gap);
    const img = await loadImage(c.image);
    ctx.save();
    // 逆位旋转
    if (c.reversed) {
      ctx.translate(x + cardW / 2, cardY + cardH / 2);
      ctx.rotate(Math.PI);
      ctx.translate(-(x + cardW / 2), -(cardY + cardH / 2));
    }
    // 牌框
    roundRect(ctx, x - 6, cardY - 6, cardW + 12, cardH + 12, 14);
    ctx.strokeStyle = "rgba(168, 85, 247, 0.55)";
    ctx.lineWidth = 3;
    ctx.stroke();
    if (img) {
      // 裁圆角
      ctx.save();
      roundRect(ctx, x, cardY, cardW, cardH, 10);
      ctx.clip();
      ctx.drawImage(img, x, cardY, cardW, cardH);
      ctx.restore();
    } else {
      ctx.fillStyle = "rgba(88, 28, 135, 0.5)";
      roundRect(ctx, x, cardY, cardW, cardH, 10);
      ctx.fill();
      ctx.fillStyle = "rgba(233, 213, 255, 0.7)";
      ctx.font = "400 30px 'Noto Serif SC', serif";
      ctx.textAlign = "center";
      ctx.fillText(c.nameZh.slice(0, 2), x + cardW / 2, cardY + cardH / 2);
    }
    ctx.restore();

    // 牌名 + 位置
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(253, 230, 138, 0.95)";
    ctx.font = "500 30px 'Noto Serif SC', serif";
    ctx.fillText(c.nameZh + (c.reversed ? "·逆" : ""), x + cardW / 2, cardY + cardH + 52);
    ctx.fillStyle = "rgba(196, 181, 253, 0.6)";
    ctx.font = "400 24px 'Noto Sans SC', sans-serif";
    ctx.fillText(c.pos, x + cardW / 2, cardY + cardH + 86);
  }

  /* ---- 摘要 ---- */
  const sumY = cardY + cardH + 160;
  ctx.textAlign = "left";
  ctx.font = "400 32px 'Noto Sans SC', sans-serif";
  ctx.fillStyle = "rgba(243, 232, 255, 0.9)";
  const lines = wrapText(ctx, data.summary, W - 240, 4);
  lines.forEach((l, i) => ctx.fillText(l, 120, sumY + i * 52));

  /* ---- 落款 ---- */
  ctx.textAlign = "center";
  ctx.font = "400 26px 'Noto Sans SC', sans-serif";
  ctx.fillStyle = "rgba(147, 129, 199, 0.55)";
  const brand = data.personaName ? `${data.personaName} · Mystic Tarot AI` : "Mystic Tarot AI";
  ctx.fillText(brand, W / 2, H - 90);
  if (data.sessionId) {
    ctx.font = "400 20px monospace";
    ctx.fillStyle = "rgba(147, 129, 199, 0.3)";
    ctx.fillText(`session ${data.sessionId.slice(0, 8)} · multi-agent × RAG × HITL`, W / 2, H - 56);
  }

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png", 0.92));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default function ShareCardButton({ data }: { data: ShareCardData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 预览弹窗：先看到图，再决定是否下载 */
  const [preview, setPreview] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const handleGenerate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const blob = await renderShareCard(data);
      if (!blob) throw new Error("canvas 渲染失败");
      // 关闭旧预览时释放旧 URL
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setPreview(url);
      setDownloaded(false);
    } catch {
      setError("生成失败，请重试");
    } finally {
      setBusy(false);
    }
  }, [busy, data]);

  /** 下载按钮：保存到本地下载文件夹 */
  const handleDownload = useCallback(() => {
    if (!previewUrlRef.current) return;
    const a = document.createElement("a");
    a.href = previewUrlRef.current;
    a.download = `mystic-tarot-${(data.sessionId ?? Date.now()).toString().slice(0, 8)}.png`;
    a.click();
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2500);
  }, [data.sessionId]);

  /** 关闭预览：释放 blob URL，避免内存泄漏 */
  const closePreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null);
  }, []);

  /** 组件卸载时释放 */
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  return (
    <>
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={handleGenerate}
        disabled={busy}
        className="px-8 py-3 rounded-full border border-amber-500/40 text-amber-200 hover:bg-amber-900/30 transition-all tracking-[0.2em] disabled:opacity-50"
        style={{ fontFamily: "'Ma Shan Zheng', serif" }}
      >
        {busy ? "绘制中…" : "生成分享卡"}
      </motion.button>
      {error && <p className="w-full text-center text-xs text-red-300/80 mt-1">{error}</p>}

      {/* 分享卡预览弹窗 */}
      {preview && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={closePreview}
        >
          <div
            className="relative max-w-[90vw] max-h-[85vh] flex flex-col items-center gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt="塔罗分享卡"
              className="max-w-full max-h-[70vh] rounded-2xl border border-amber-500/30 shadow-[0_0_60px_rgba(251,191,36,0.25)]"
            />
            <div className="flex gap-3">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={handleDownload}
                className="px-6 py-2.5 rounded-full bg-gradient-to-r from-amber-600 to-orange-600 text-white font-medium shadow-[0_0_20px_rgba(251,191,36,0.4)]"
              >
                {downloaded ? "已保存到下载文件夹 ✓" : "保存图片"}
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={closePreview}
                className="px-6 py-2.5 rounded-full border border-purple-400/40 text-purple-200 hover:bg-purple-900/40"
              >
                关闭
              </motion.button>
            </div>
            <p className="text-xs text-purple-300/50">保存位置：浏览器默认下载文件夹（如 C:\Users\...\Downloads）</p>
          </div>
        </div>
      )}
    </>
  );
}
