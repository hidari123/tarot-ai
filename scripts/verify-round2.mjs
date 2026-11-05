#!/usr/bin/env node
/**
 * 验证：第二轮优化（docs/optimization-analysis-2026-11.md 的 22 项）
 *
 * ⚠️ 为什么这份脚本存在：
 *   那份分析文档列了 22 项优化（P0 六项 / P1 八项 / P2 八项）。
 *   它们大多是"看不见的"改动 —— 索引、内存清理、字段契约、快照结构 ——
 *   **tsc 和 eslint 都发现不了它们被改回去**。
 *   所以这里把它们变成**代码级契约**，任何人 revert 都会让 CI 变红。
 *
 * 断言分五组：
 *   ① P0：数据库索引 / 清理覆盖 / 内存泄漏 / 审校标记 / schema 契约
 *   ② P0：错误边界（客户端异常不能白屏）
 *   ③ P1：prompt 瘦身 / 预检索命中 / 快照写入量 / busy 所有权 / seq 续号
 *   ④ P2：a11y / 代码分割 / 字体 / 动效降级 / 定时器清理
 *   ⑤ 回归防护：既有契约没被破坏
 *
 * 用法：npx tsx scripts/verify-round2.mjs
 */

import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

/** 剥离注释（避免注释里的关键词造成假阳性） */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

console.log("=== 第二轮优化验证 ===\n");

/* ────────────── ① P0：数据库与内存 ────────────── */
console.log("【① P0 数据层】（索引 / 清理 / 内存泄漏）");
{
  const db = readFileSync("src/lib/db.ts", "utf-8");
  const dbCode = strip(db);

  // ① share_token 索引
  check("share_token 有索引（分享链接不再全表扫）",
    /CREATE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions\(share_token\)/.test(db),
    "在 ALTER TABLE 迁移之后创建");

  // ⑤ 清理覆盖
  const cleaned = [...dbCode.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]);
  check("每日清理覆盖 session_timings（原本漏了 → 无限增长）",
    cleaned.includes("session_timings"), `已清理: ${[...new Set(cleaned)].join(", ")}`);
  check("每日清理覆盖 user_profiles", cleaned.includes("user_profiles"));

  // ⑬ JSON 解析兜底
  check("cards_json 用 safeParse（一张脏数据不该让 dashboard 500）",
    !/cards: JSON\.parse\(/.test(dbCode) && /cards: safeParse\(/.test(dbCode));
  check("getSessionReading 也用 safeParse", /cards: safeParse\(row\.cards_json/.test(dbCode));

  // ⑫ seq 续号
  check("提供 getMaxEventSeq（恢复会话时续号不重号）", /export function getMaxEventSeq/.test(db));

  // ⑨ messages 剥离
  check("有 session_messages 表（append-only）", /CREATE TABLE IF NOT EXISTS session_messages/.test(db));
  check("快照保存时剥离 messages", /delete rest\.messages/.test(dbCode));
  check("读取时把 messages 拼回（对上层透明）", /snap\.messages = msgs/.test(dbCode));
}

{
  const trunc = readFileSync("src/lib/agent/truncation.ts", "utf-8");
  const sup = readFileSync("src/lib/agent/supervisor.ts", "utf-8");
  const supCode = strip(sup);

  // ② clearTruncated 有调用点了
  check("clearTruncated 有调用点（truncatedSessions 不再只增不减 → 内存泄漏）",
    /clearTruncated\(/.test(sup) && !/import.*truncation/.test(supCode) === false);
  check("清理放在最外层 finally（所有退出路径都清）",
    /finally[\s\S]{0,900}clearTruncated\(session\.id\)/.test(supCode));

  // ⑩ busy 所有权唯一
  check("supervisor 不再写 session.busy（所有权归路由层）",
    !/session\.busy = true/.test(supCode) && !/session\.busy = false/.test(supCode));
  const route = readFileSync("src/app/api/interpret/route.ts", "utf-8");
  check("路由层仍负责占用与释放", /tryAcquireSession/.test(route) && /releaseSession/.test(route));

  // ⑪ prompt_version 只写一次
  const versionWrites = (supCode.match(/updateSessionPromptVersion\(/g) || []).length;
  check("prompt_version 只写一次（原本写两次、前者被覆盖）",
    versionWrites === 1, `实际 ${versionWrites} 次`);

  // ⑭ MAX_ROUNDS 动态
  check("MAX_ROUNDS 按牌数动态计算", /cardCount \* 2 \+ 8/.test(supCode));
  // ⚠️ 2026-11-04 双模式：深度模式保留下限 22（安全网），
  //   快速模式用更小的上限 —— 但仍不低于按牌数算出的值。
  check("深度模式 MAX_ROUNDS 有下限（不小于原值 22）",
    /session\.mode === "quick" \? 0 : BASE_ROUNDS/.test(supCode) &&
    /Math\.max\(\s*modeProfile_\.maxRounds/.test(supCode),
    "快速模式用更小的上限；深度模式保持 ≥22");

  // ⑦ tool 结果不回显 arguments
  // ⚠️ 判据要精确：只查 **tool 消息的 content** 里有没有回显，
  //   不能查整个文件 —— `slot.reveal = { narrative, meaning, question }`
  //   是**存进 session 状态**（前端要显示牌面叙述），是必要的，不是浪费。
  const toolMsgs = [...supCode.matchAll(/role: "tool"[\s\S]{0,320}?content: JSON\.stringify\(\{([\s\S]{0,220}?)\}\)/g)]
    .map((m) => m[1]);
  check("reveal_card 的 tool 结果不回显 narrative/meaning/question",
    toolMsgs.every((b) => !/narrative/.test(b) && !/meaning/.test(b)),
    `${toolMsgs.length} 处 tool 消息`);
  check("close_reading 不回显 closing/question",
    !/\{ closing, question, userAnswer/.test(supCode));
  check("establish_contract 不回显 contract",
    !/\{ contract: session\.contractQuestion/.test(supCode));
  check("工具结果仍带新增信息（userAnswer / saved / scope）",
    /userAnswer/.test(supCode) && /saved: true/.test(supCode) && /userConfirmed/.test(supCode));
}

{
  // ③ 降级 review 标 truncated
  const sub = readFileSync("src/lib/agent/subagents.ts", "utf-8");
  const subCode = strip(sub);
  check("审校解析失败降级会标 truncated（不谎报 pass）",
    /truncated: true/.test(subCode));
  check("ReviewResult 类型含 truncated 字段", /truncated\?: boolean/.test(subCode));

  // ④ schema 契约
  const schema = readFileSync("src/lib/agent/schema.ts", "utf-8");
  check("ReviewSchema 声明 truncated（zod 会剥离未声明字段）",
    /truncated: z\.boolean\(\)\.optional\(\)/.test(schema));
}

{
  // ⑧ 预检索命中
  const rag = readFileSync("src/lib/agent/tools/rag.ts", "utf-8");
  const ragCode = strip(rag);
  check("缓存查找是柔性的（牌名子串匹配 → 预取能命中）",
    /readCacheFlexible/.test(ragCode) && /normalized\.includes\(cachedQuery\)/.test(ragCode));
  check("预取按多个 top_k 各存一份（模型常用 k=10）",
    /new Set\(\[topK, 5, 10\]\)/.test(ragCode));
  check("execRagSearch 用柔性查找", /readCacheFlexible\(query, k\)/.test(ragCode));
}

{
  // ⑫ event-log 续号
  const elog = readFileSync("src/lib/agent/event-log.ts", "utf-8");
  check("新建 buffer 时用 DB 的 max(seq) 初始化 nextSeq",
    /db\.getMaxEventSeq\(sessionId\) \+ 1/.test(elog));
}

/* ────────────── ② P0：错误边界 ────────────── */
console.log("\n【② P0 错误边界】（客户端异常不能白屏）");
{
  check("路由级错误边界存在", existsSync("src/app/error.tsx"));
  check("根级错误边界存在", existsSync("src/app/global-error.tsx"));
  if (existsSync("src/app/error.tsx")) {
    const err = readFileSync("src/app/error.tsx", "utf-8");
    check("错误边界提供重试出口", /reset\(\)/.test(err) && /onClick/.test(err));
    check("错误边界提供回首页出口（用 router 而非 location.href）",
      /router\.push\("\/"\)/.test(err) && /useRouter/.test(err));
    check("错误边界记录到 console（可排查）", /console\.error/.test(err));
  }
  if (existsSync("src/app/global-error.tsx")) {
    const gerr = readFileSync("src/app/global-error.tsx", "utf-8");
    check("global-error 自己渲染 html/body（Next.js 硬性要求）",
      /<html/.test(gerr) && /<body/.test(gerr));
    // ⚠️ global-error 不在 Router 上下文里 → 只能用 location.href（且需豁免 lint）
    check("global-error 用 location.href 回首页（Router 在此不可用）",
      /window\.location\.href = "\/"/.test(gerr) &&
      /eslint-disable-next-line @next\/next\/no-location-assign-relative-destination/.test(gerr));
  }
}

/* ────────────── ③ P1：prompt 与数据流 ────────────── */
console.log("\n【③ P1 成本与正确性】");
{
  const helper = readFileSync("src/lib/agent/helpers.ts", "utf-8");
  const helperCode = strip(helper);
  check("trimHistory 仍在（发给模型的副本会被压缩）", /export function trimHistory/.test(helperCode));
  check("trimHistory 保留抽牌类工具结果不压缩", /NEVER_COMPRESS/.test(helperCode));

  const sess = readFileSync("src/lib/agent/session.ts", "utf-8");
  const sessCode = strip(sess);
  check("启动恢复用 loadSessionState（否则丢掉剥离出去的消息）",
    /db\.loadSessionState\(row\.id\)/.test(sessCode));
}

/* ────────────── ④ P2：体验与工程债 ────────────── */
console.log("\n【④ P2 体验与工程债】（a11y / 分割 / 字体 / 动效 / 定时器）");
{
  const page = readFileSync("src/app/page.tsx", "utf-8");
  const pageCode = strip(page);

  // ⑯ 代码分割
  check("ShareCard 用 next/dynamic 懒加载",
    /dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/ShareCard"\)/.test(pageCode));
  check("SubAgentPipeline 用 next/dynamic 懒加载",
    /dynamic\(\s*\(\)\s*=>\s*import\("@\/components\/SubAgentPipeline"\)/.test(pageCode));
  check("不再静态 import ShareCard", !/^import ShareCardButton from/m.test(pageCode));
  check("不再静态 import SubAgentPipeline", !/^import SubAgentPipeline,/m.test(pageCode));

  // ⑮ a11y
  const modal = readFileSync("src/components/CardPreviewModal.tsx", "utf-8");
  check("牌面预览有 role=dialog", /role="dialog"/.test(modal));
  check("牌面预览有 aria-modal", /aria-modal="true"/.test(modal));
  check("牌面预览有焦点陷阱（Tab 不跑出模态框）", /e\.key === "Tab"/.test(modal));
  check("牌面预览关闭后焦点还原", /prevFocusRef\.current\?\.focus/.test(modal));
  check("输入框有 aria-label（placeholder 不是可访问名称）",
    (pageCode.match(/aria-label="[^"]+"/g) || []).length >= 3);

  // ⑲ 字体
  const share = readFileSync("src/components/ShareCard.tsx", "utf-8");
  const shareCode = strip(share);
  check("Canvas 不再用不存在的 Noto 字体", !/Noto Serif SC|Noto Sans SC/.test(shareCode));
  check("Canvas 绘制前等待字体加载", /ensureFontsReady/.test(shareCode));
  check("字体栈用系统必有的中文字体", /PingFang SC/.test(shareCode) && /Microsoft YaHei/.test(shareCode));
  const pkg = readFileSync("package.json", "utf-8");
  /**
   * ⚠️ 2026-11-05 视觉重设计：这个断言的**含义变了**（不是简单删掉）。
   *
   * ⚠️ 原来：断言 noto-serif-sc 是"死依赖"（装了但没用 → 白占体积）。
   *   当时的结论是"正文用系统字体就够了"。
   *
   * ⚠️ 现在：视觉重设计需要**中文衬线体**（Noto Serif SC）——
   *   正文全是系统默认无衬线是"廉价感"的最大来源。
   *   → 依赖变成"活依赖"，但必须守两条：
   *     ① 真的被引用（layout.tsx import）—— 否则又是死依赖
   *     ② 只引 chinese-simplified 子集（不是全量 1632 分片）
   */
  const layoutSrc = readFileSync("src/app/layout.tsx", "utf-8");
  check(
    "noto-serif-sc 是活依赖（layout 真的引入了）",
    /noto-serif-sc/.test(pkg) && /@fontsource\/noto-serif-sc/.test(layoutSrc)
  );
  check(
    "noto-serif-sc 只引 chinese-simplified 子集（避免打进 1632 个分片）",
    /noto-serif-sc\/chinese-simplified-400\.css/.test(layoutSrc) &&
      !/noto-serif-sc\/400\.css/.test(layoutSrc)
  );
  check("字体角色系统已建立（body 用衬线 + .font-ui 用于 UI）",
    /--font-serif: "Noto Serif SC"/.test(readFileSync("src/app/globals.css", "utf-8")) &&
      /\.font-ui/.test(readFileSync("src/app/globals.css", "utf-8")));

  // ⑳ 动效降级
  const css = readFileSync("src/app/globals.css", "utf-8");
  check("globals.css 有 prefers-reduced-motion 全局降级",
    /@media \(prefers-reduced-motion: reduce\)/.test(css));
  check("降级覆盖 animation/transition", /animation-duration: 0\.01ms/.test(css));
  check("有 MotionProvider（framer-motion 的 JS 动画也要降级）",
    existsSync("src/components/MotionProvider.tsx"));
  const layout = readFileSync("src/app/layout.tsx", "utf-8");
  check("layout.tsx 挂载 MotionProvider", /<MotionProvider>/.test(layout));

  // ㉒ 定时器清理
  const cited = readFileSync("src/components/CitedReading.tsx", "utf-8");
  check("CitedReading 的定时器有 cleanup", /clearTimeout/.test(cited));
  const kp = readFileSync("src/components/KnowledgePanel.tsx", "utf-8");
  check("KnowledgePanel 的定时器有 cleanup", /clearTimeout/.test(kp));
  const fan = readFileSync("src/components/CardFan.tsx", "utf-8");
  check("CardFan 的定时器有 cleanup", /clearTimeout/.test(fan));
  check("page.tsx 的 rAF 有 cancel", /cancelAnimationFrame/.test(pageCode));
}

/* ────────────── ⑤ 回归防护 ────────────── */
console.log("\n【⑤ 回归防护】（既有契约没被破坏）");
{
  const ambient = readFileSync("src/lib/audio/ambient.ts", "utf-8");
  const ambientCode = strip(ambient);
  check("音频引擎仍无持续音（第三轮改动的契约没被破坏）",
    !/makeDrone/.test(ambientCode) && !/shimmerVoices/.test(ambientCode));

  const gate = existsSync("src/components/AmbienceGate.tsx");
  check("AmbienceGate 仍已删除", !gate);

  const page = readFileSync("src/app/page.tsx", "utf-8");
  check("占卜开始仍解锁音频", /void unlockAmbience\(\)/.test(page));
  check("翻牌/答问音效仍在", /playSfx\("flip"\)/.test(page) && /playSfx\("answer"\)/.test(page));

  const events = readFileSync("src/lib/agent/event-log.ts", "utf-8");
  check("事件缓冲仍挂 globalThis（HMR 安全）", /runtimeState/.test(events));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
