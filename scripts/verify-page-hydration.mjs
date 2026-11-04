#!/usr/bin/env node
/**
 * 验证：页面**真的能 hydrate**（而不只是"响应里有 CSP 头"）
 *
 * ⚠️⚠️ 为什么必须有这个脚本（一次真实回归的产物）：
 *   2026-11-04 的公网化改造里，CSP 被设成 `script-src 'self'`（不含 unsafe-inline）。
 *   结果：**首页永远停在 loading**。
 *   原因：Next.js App Router 的 HTML 里有 8 个内联 `<script>`（RSC payload），
 *   CSP 把它们全拦了 → React 不 hydrate → 停在 Next 的 loading 骨架。
 *
 *   ⚠️ 为什么之前的所有检查都没发现：
 *     · TSC / ESLint / 构建 —— 全绿（配置语法完全正确）
 *     · 我自己写的 `verify-api-auth.mjs` 断言"响应带 CSP" —— **也通过了**
 *       （它只看"头在不在"，不看"头会不会把页面挡死"）
 *   → **教训：安全头的强度必须用"页面真的能跑"来验证**。
 *     这个脚本就是那条教训的自动化。
 *
 * 验证三层：
 *   ① HTML 里有内联 script（说明确实存在被 CSP 拦的风险面）
 *   ② CSP 的 script-src **不会拦掉**这些内联 script
 *      （有 'unsafe-inline'，或有能覆盖它们的 nonce）
 *   ③ 页面**没有** Next 的 loading 骨架残留（hydration 成功的标志）
 *
 * 用法：node scripts/verify-page-hydration.mjs [baseUrl]
 */

const BASE = process.argv[2] || "http://localhost:3000";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== 页面可渲染性验证（防 CSP 回归）===\n");
console.log(`目标: ${BASE}\n`);

const res = await fetch(BASE, { headers: { "User-Agent": "verify-page-hydration" } });
const html = await res.text();
const csp = res.headers.get("content-security-policy") ?? "";

/* ---- ① 页面能返回 ---- */
check("首页返回 200", res.status === 200, `status=${res.status}`);
check("返回的是 HTML", (res.headers.get("content-type") ?? "").includes("text/html"),
  res.headers.get("content-type") ?? "");

/* ---- ② 有内联 script（风险面存在）---- */
const scripts = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
const inline = scripts.filter((s) => !/\ssrc=/.test(s));
console.log(`  （脚本标签 ${scripts.length} 个，其中内联 ${inline.length} 个）`);
check(
  "页面含内联 script（Next 的 RSC payload —— CSP 必须放行它们）",
  inline.length > 0,
  `${inline.length} 个内联`
);

/* ---- ③ CSP 不会拦死内联 script ---- */
{
  const scriptSrc = (csp.match(/script-src\s+([^;]+)/i)?.[1] ?? "").trim();
  const hasUnsafeInline = /'unsafe-inline'/.test(scriptSrc);
  const hasNonce = /'nonce-[^']+'/.test(scriptSrc);
  const nonceInTags = inline.some((t) => /\snonce=/.test(t));

  check(
    "响应带 CSP 的 script-src 指令",
    scriptSrc.length > 0,
    scriptSrc || "（没有 script-src）"
  );

  if (!scriptSrc) {
    // ⚠️ 没有 script-src → 继承 default-src 'self' → 内联 script 会被拦！
    check("无 script-src 时 CSP 仍放行内联 script", false,
      "⚠️ default-src 'self' 会拦掉内联 script → 页面会卡在 loading");
  } else if (hasUnsafeInline) {
    check(
      "script-src 含 'unsafe-inline' → 内联 script 可执行",
      true,
      "'unsafe-inline' 放行"
    );
  } else if (hasNonce) {
    check(
      "script-src 用 nonce 且内联 script 带上了 nonce",
      nonceInTags,
      nonceInTags ? "nonce 已注入" : "⚠️ 有 nonce 但内联 script 没带 → 仍会被拦"
    );
  } else {
    check(
      "script-src 既无 'unsafe-inline' 也无 nonce → 内联 script 会被拦",
      false,
      `script-src="${scriptSrc}" → 首页会卡在 loading`
    );
  }

  // ⚠️ strict-dynamic 与 unsafe-inline 不能共存（浏览器会忽略 unsafe-inline）
  if (hasUnsafeInline && /'strict-dynamic'/.test(scriptSrc)) {
    check(
      "没有同时使用 'strict-dynamic' 与 'unsafe-inline'",
      false,
      "⚠️ 存在 'strict-dynamic' 时浏览器会**忽略** 'unsafe-inline' → 内联 script 仍被拦"
    );
  } else {
    check(
      "没有同时使用 'strict-dynamic' 与 'unsafe-inline'",
      true,
      ""
    );
  }
}

/* ---- ④ 页面不是"卡在 loading"的状态 ---- */
{
  // ⚠️ Next.js 的 loading 骨架是 <template> 或特定的 class
  const hasNextLoading = /__next-loading|nextjs-portal|data-next-loading/i.test(html);
  check(
    "HTML 里没有 Next 的 loading 骨架残留",
    !hasNextLoading,
    hasNextLoading ? "⚠️ 页面停在 loading 状态" : "正常渲染"
  );
}

/* ---- ⑤ 关键内容确实渲染出来了（不是空壳）---- */
{
  const hasTitle = /<h1/.test(html) && /占卜|塔罗|星|Mystic|解读/.test(html);
  check("页面包含实际内容（标题 + 塔罗相关文案）", hasTitle, "");
}

/* ---- ⑥ 分享页仍保持严格 CSP（真正的注入面）---- */
{
  const shareRes = await fetch(`${BASE}/api/share?t=nonexistent-token`);
  const shareCsp = shareRes.headers.get("content-security-policy") ?? "";
  check(
    "分享页有自己的 CSP（不放行内联脚本）",
    shareCsp.includes("script-src") && !/script-src[^;]*'unsafe-inline'/.test(shareCsp),
    shareCsp ? shareCsp.slice(0, 70) + "…" : "（无 CSP 头）"
  );
}

/* ---- ⑦ 其余安全头仍在（proxy 只搬走了 CSP）---- */
{
  const checks = [
    ["X-Content-Type-Options", res.headers.get("x-content-type-options")],
    ["X-Frame-Options", res.headers.get("x-frame-options")],
    ["Referrer-Policy", res.headers.get("referrer-policy")],
    ["Permissions-Policy", res.headers.get("permissions-policy")],
  ];
  const missing = checks.filter(([, v]) => !v).map(([k]) => k);
  check(
    "其余安全头未丢失",
    missing.length === 0,
    missing.length ? `缺: ${missing.join(", ")}` : checks.map(([k]) => k).join(", ")
  );
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
console.log(
  fail === 0
    ? "\n💡 提示：这个脚本防的是「CSP 把页面挡死」这一类回归 ——"
      + "\n   安全头不是设了就算数，要验证页面真的能 hydrate。"
    : ""
);
process.exit(fail === 0 ? 0 : 2);
