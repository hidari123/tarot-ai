import { getSessionReading, getSessionByShareToken, ensureShareToken } from "@/lib/db";
import { getCardById } from "@/lib/tarot-cards";
import { generateShareToken, withSecurityHeaders } from "@/lib/api-auth";

/**
 * 解读分享卡（P2-⑭ · P1-④ 加固）
 *
 * GET /api/share?t=<shareToken>          → 可分享的 HTML 卡片（独立页面）
 * GET /api/share?t=<shareToken>&fmt=json → 结构化数据（前端预览用）
 *
 * ⚠️ 为什么服务端生成 HTML 而不是前端截图：
 *   - 截图依赖 html2canvas 之类的库，会把 ~200KB 塞进客户端
 *   - 服务端生成的 HTML **天然可分享**（一个 URL 就能给别人看）
 *   - 移动端截图体验差，"生成一张漂亮的图"反而不如"发个链接"
 *
 * ⚠️ 为什么要做这个（产品价值）：
 *   占卜结果天然是"想分享"的内容（发给朋友、发给对象、存档纪念）。
 *   一个能直接转发的链接 = 产品的自然传播入口。
 *   这也是从"工具"变成"社交产品"的关键一步。
 *
 * ⚠️ P1-④：为什么用**独立的 shareToken** 而不是 sessionId：
 *   审计实测：原来 `?id=<sessionId>` 直接返回私密解读全文，
 *   而 sessionId 格式是 `sess_${时间戳36进制}_${随机6位}` —— 时间戳可枚举。
 *   更严重的是：**sessionId 是会话控制凭证**（能 answer/interject），
 *   分享出去等于把"替用户操作占卜师"的能力也给出去了。
 *   现在：独立的 128bit shareToken，只能读不能控。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const fmt = url.searchParams.get("fmt");
  // ⚠️ 分享凭证：t = shareToken（128bit，不可枚举）
  const token = url.searchParams.get("t");

  if (token) {
    const row = getSessionByShareToken(token);
    if (!row) {
      return withSecurityHeaders(
        Response.json({ error: "分享链接无效或已失效" }, { status: 404 })
      );
    }
    const cards = row.cards ?? [];

    if (fmt === "json") {
      return withSecurityHeaders(
        Response.json({
          id: row.id,
          question: row.question,
          reading: row.reading,
          cards: cards.map((c) => ({
            ...c,
            // 补上牌面图片 URL（前端渲染分享卡用）
            image: getCardById(c.id)?.image ?? "",
          })),
        })
      );
    }

    const html = renderShareCard(row.id, row.question, row.reading, cards);
    return new Response(html, { headers: shareHeaders() });
  }

  // ⚠️ 兼容路径：老链接只有 id（没有 shareToken）。
  //    不再直接返回内容 —— 改为签发一个 shareToken 并提示前端换用新链接。
  //    （否则"可枚举的 id"依然能拿到私密内容）
  if (id) {
    const reading = getSessionReading(id);
    if (!reading) {
      return withSecurityHeaders(
        Response.json({ error: "解读不存在" }, { status: 404 })
      );
    }
    const shareToken = ensureShareToken(id, generateShareToken);
    return withSecurityHeaders(
      Response.json(
        {
          error: "请使用带分享令牌的链接",
          shareToken,
          url: `/api/share?t=${shareToken}`,
        },
        { status: 400 }
      )
    );
  }

  return withSecurityHeaders(
    Response.json({ error: "缺少分享令牌" }, { status: 400 })
  );
}

/** 分享页的安全响应头 */
function shareHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    // ⚠️ 允许被搜索引擎收录？不 —— 解读内容是私人的，noindex
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    // ⚠️ script-src 'none' —— 分享页不需要脚本，且内容是用户生成的
    "Content-Security-Policy":
      "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'",
  };
}

/** 把解读正文按段落拆开（分享卡按段落渲染，比一整块好看） */
function splitParagraphs(reading: string): string[] {
  return reading
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 渲染分享卡 HTML
 *
 * ⚠️ 安全：所有用户内容都要转义（XSS）。
 *    问题、解读正文都可能包含 <script> —— 用户自己输入的内容
 *    被别人打开时会变成攻击面。
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 单行化（用于 title 属性等不适合换行的场景） */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function renderShareCard(
  id: string,
  question: string,
  reading: string,
  cards: Array<{ id: string; nameZh: string; reversed: boolean; pos: string }>
): string {
  const paragraphs = splitParagraphs(reading);
  const cardHtml = cards
    .map((c) => {
      const card = getCardById(c.id);
      const img = card?.image ?? "";
      return `
      <div class="card">
        ${img ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(c.nameZh)}" />` : `<div class="card-noimg">✦</div>`}
        <div class="card-pos">${escapeHtml(c.pos)}</div>
        <div class="card-name">${escapeHtml(c.nameZh)}${c.reversed ? " · 逆位" : ""}</div>
      </div>`;
    })
    .join("\n");

  const bodyHtml = paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");

  const dateStr = new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(oneLine(question) || "一场占卜")} · 神秘塔罗</title>
<style>
  :root {
    --ink: #1a1524;
    --paper: #f7f3ec;
    --accent: #6b4f8a;
    --muted: #7a6f86;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 16px;
    background: linear-gradient(160deg, #1c1726 0%, #2b2238 55%, #382a44 100%);
    color: #e8e0f0;
    font-family: "Noto Serif SC", "Songti SC", Georgia, serif;
    min-height: 100vh;
  }
  .card-shell {
    max-width: 640px; margin: 0 auto;
    background: var(--paper); color: var(--ink);
    border-radius: 18px; padding: 36px 32px;
    box-shadow: 0 24px 60px rgba(0,0,0,.45);
    position: relative; overflow: hidden;
  }
  .card-shell::before {
    content: ""; position: absolute; inset: 0;
    background:
      radial-gradient(circle at 12% 8%, rgba(107,79,138,.10), transparent 42%),
      radial-gradient(circle at 88% 92%, rgba(107,79,138,.08), transparent 46%);
    pointer-events: none;
  }
  header { text-align: center; border-bottom: 1px solid rgba(26,21,36,.12); padding-bottom: 20px; }
  .sigil { font-size: 26px; opacity: .55; }
  h1 { font-size: 19px; font-weight: 600; margin: 10px 0 6px; letter-spacing: .04em; }
  .meta { font-size: 12px; color: var(--muted); letter-spacing: .08em; }
  .question {
    margin: 22px 0; padding: 16px 18px;
    background: rgba(107,79,138,.07); border-left: 3px solid var(--accent);
    border-radius: 0 8px 8px 0; font-size: 15px; line-height: 1.75;
  }
  .cards { display: flex; justify-content: center; gap: 14px; margin: 24px 0; flex-wrap: wrap; }
  .card { text-align: center; width: 108px; }
  .card img {
    width: 100%; border-radius: 8px; display: block;
    box-shadow: 0 6px 16px rgba(0,0,0,.18);
  }
  .card-noimg {
    width: 100%; aspect-ratio: 2/3; border-radius: 8px;
    background: linear-gradient(160deg, #6b4f8a, #4a3566);
    display: flex; align-items: center; justify-content: center;
    color: #e8ddf5; font-size: 30px;
  }
  .card-pos { font-size: 11px; color: var(--muted); margin-top: 7px; letter-spacing: .1em; }
  .card-name { font-size: 13px; margin-top: 2px; font-weight: 600; }
  .reading p { font-size: 14.5px; line-height: 2; margin: 0 0 16px; text-align: justify; }
  .reading p:first-child::first-letter { font-size: 1.4em; }
  footer {
    margin-top: 28px; padding-top: 16px; border-top: 1px solid rgba(26,21,36,.12);
    text-align: center; font-size: 11.5px; color: var(--muted); letter-spacing: .06em;
  }
  footer a { color: var(--accent); text-decoration: none; }
  @media (max-width: 480px) {
    .card-shell { padding: 26px 20px; }
    .card { width: 88px; }
  }
</style>
</head>
<body>
<div class="card-shell">
  <header>
    <div class="sigil">✦</div>
    <h1>${escapeHtml(oneLine(question) || "一场占卜")}</h1>
    <div class="meta">${escapeHtml(dateStr)} · 神秘塔罗</div>
  </header>

  <div class="question">${escapeHtml(oneLine(question))}</div>

  ${cardHtml ? `<div class="cards">${cardHtml}</div>` : ""}

  <div class="reading">
${bodyHtml}
  </div>

  <footer>
    占卜显示的是倾向，不是判决 —— 决定权始终在你手里。<br/>
    由 <a href="/">神秘塔罗</a> 生成
  </footer>
</div>
</body>
</html>`;
}
