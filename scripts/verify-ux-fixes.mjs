#!/usr/bin/env node
/**
 * 验证：2026-11-04 的 UX 修复（B1~B3）
 *
 * ⚠️ 这批修复来自用户的实测报告：
 *   ① 追问每次进去都说"超过 30 分钟" → 改成按 canFollowup 判断
 *   ② 全屏却有右侧滚动条 → 改成 min-h-[100dvh]
 *   ③ 限流被用户感知 → 文案去技术化
 *   ④ 收束后停在那里 → 回响 + 落点卡片
 *   ⑤ 模型思考时没有动画 → 思考气泡
 *   ⑥ 牌出现但点不动 → 提前置 current + 待命视觉 + 乐观反馈
 *
 * 用法：npx tsx scripts/verify-ux-fixes.mjs
 */

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

console.log("=== UX 修复验证（2026-11-04）===\n");

/**
 * ⚠️⚠️ 2026-11-12 拆分：部分前端逻辑搬到了 src/features/divination/
 *    → "前端有没有 X"这类断言必须把两处都算上
 *    → 直接扩展 page 的值 → 所有 .test(page) 自动覆盖新位置 ✅
 */
const FEATURE_FILES = [
  "src/features/divination/useStreamRunner.ts",
  "src/features/divination/useSseParser.ts",
  "src/features/divination/useDeltaBuffer.ts",
  "src/features/divination/useFlowEntries.ts",
  "src/features/divination/useDivinationState.ts",
  "src/features/divination/types.ts",
  "src/features/divination/useCardActions.ts",
  "src/features/divination/useFollowup.ts",
  "src/features/divination/components/HeroSection.tsx",
  "src/features/divination/components/EntryCards.tsx",
  "src/features/divination/components/DivinationInput.tsx",
  "src/features/divination/components/StageProgress.tsx"
];
const featureCode = FEATURE_FILES.map((f) => {
  try { return readFileSync(f, "utf-8"); } catch { return ""; }
}).join("\n");
const page = readFileSync("src/app/page.tsx", "utf-8") + featureCode;
// ⚠️ 2026-11-12 拆分：状态搬进了 useDivinationState → 断言要同时看两处
const stateHook = readFileSync(
  "src/features/divination/useDivinationState.ts",
  "utf-8"
);
const frontCode = page + "\n" + stateHook;
const sessionApi = readFileSync("src/app/api/session/[id]/route.ts", "utf-8");
const layout = readFileSync("src/app/layout.tsx", "utf-8");
const globals = readFileSync("src/app/globals.css", "utf-8");
const cardSpread = readFileSync("src/components/CardSpread.tsx", "utf-8");
const dialogue = readFileSync("src/components/DialogueFlow.tsx", "utf-8");
const thinking = readFileSync("src/components/ThinkingBubble.tsx", "utf-8");
const closing = readFileSync("src/components/ClosingPanel.tsx", "utf-8");
const echo = readFileSync("src/lib/agent/echo.ts", "utf-8");
const supervisor = readFileSync("src/lib/agent/supervisor.ts", "utf-8");
const hitl = readFileSync("src/lib/agent/hitl.ts", "utf-8");
const helpers = readFileSync("src/lib/agent/helpers.ts", "utf-8");

/**
 * ⚠️ 剥离注释后再检查
 * ⚠️ 为什么必须这样（踩过一次）：
 *   注释里**大量**出现这些术语（正是为了记录"我们以前写过这些"），
 *   直接 grep 整个文件会误报"仍存在"。
 *   → 只检查**会渲染到界面上的代码**。
 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
    .replace(/\/\/.*$/gm, "");           // 行注释

const pageCode = stripComments(page);
const thinkingCode = stripComments(thinking);

/* ══════════════ ① 追问：canFollowup 契约 ══════════════ */
console.log("【① 追问入口（用户报告：每次都说超过 30 分钟）】");
{
  check("服务端返回 canFollowup 字段", /canFollowup:\s*!live\.finished/.test(sessionApi),
    "内存会话且未完成 → 可追问");
  check("DB 分支也返回 canFollowup（明确 false）", /canFollowup:\s*false/.test(sessionApi));
  check("DB 分支仍返回 reading（不能追问 ≠ 不能看）",
    /canFollowup:\s*false[\s\S]{0,200}reading:\s*persisted\.reading/.test(sessionApi));

  check("前端按 canFollowup 判断（不再只看 r.ok）",
    /data\.canFollowup/.test(page));
  check("不可追问时不回填 sessionId",
    /canFollowup[\s\S]{0,700}setSessionId\(""\)/.test(page));
  check("不可追问时清掉 localStorage（不重复探测）",
    /canFollowup[\s\S]{0,900}localStorage\.removeItem\("tarot:sessionId"\)/.test(page));

  check("不再出现「超过 30 分钟」的错误文案",
    !pageCode.includes("超过 30 分钟"),
    pageCode.includes("超过 30 分钟") ? "仍在可渲染代码里" : "已移除");
  check("410 时静默收起追问入口（不弹错误横幅）",
    /setError\(""\)/.test(page));

  check("前端维护 canFollowup state", /const \[canFollowup, setCanFollowup\]/.test(frontCode));
  check("新会话建立时 canFollowup=true", /setCanFollowup\(true\)/.test(page));
}

/* ══════════════ ② 滚动条 ══════════════ */
console.log("\n【② 全屏却有右侧滚动条】");
{
  check("主体用 min-h-[100dvh]（不含滚动条 + 移动端自适应）",
    /min-h-\[100dvh\]/.test(pageCode));
  check("不再用 min-h-screen（100vh 含滚动条）", !/min-h-screen/.test(pageCode));
  check("body 去掉冗余的 min-h-full（溢出的帮凶）",
    !/className="min-h-full flex flex-col"/.test(layout));
  check("globals.css 有 dvh 兜底（老浏览器）",
    /@supports not \(height: 100dvh\)/.test(globals));
}

/* ══════════════ ③ 限流不让人感知 ══════════════ */
console.log("\n【③ 限流去技术化（用户报告：别让用户感知到限流）】");
{
  // ⚠️ 关键断言：**用户可见的文案里不能出现内部术语**
  // ⚠️ 判据（踩了两次才精确）：只看 **JSX 文本节点** 与 **模板字符串**。
  //    · JSX 文本：>文字<
  //    · 模板字符串：`文字`
  //    而像 includes("限流") 这种是**内部检测**（判断后端 phase 标签），
  //    不会显示给用户 —— 不能算违规。
  const jsxText = [...pageCode.matchAll(/>([^<>{}\n]{2,})</g)].map((m) => m[1]);
  const templateText = [...pageCode.matchAll(/`([^`\n]{4,})`/g)].map((m) => m[1]);
  const visibleText = [...jsxText, ...templateText].join("\n");

  const FORBIDDEN = ["限流", "429", "配额", "速率限制", "熔断", "模型仍在思考", "定位瓶颈", "超过 30 分钟"];
  for (const term of FORBIDDEN) {
    check(
      `用户可见文案无「${term}」字样`,
      !visibleText.includes(term),
      visibleText.includes(term) ? "出现在可见文案里" : "仅在注释或内部检测中（OK）"
    );
  }
  // ⚠️ 但**允许**检测后端标签（那是内部逻辑，不是显示文案）
  check(
    "允许内部检测限流标签（不是显示文案）",
    /includes\("限流"\)/.test(pageCode),
    "检测 phase 标签 → setRateLimited"
  );
  check("等待文案有占卜师口吻的短句池", /PHRASES/.test(page));
  check("等待分级：<3s 不显示", /elapsed < 3/.test(page));
  check("思考气泡有占卜师口吻短句池", /PHRASES/.test(thinking));
  check("思考气泡短句也不含技术术语",
    !/限流|429|配额|请求速率/.test(thinkingCode));
}

/* ══════════════ ④ 收束回响 + 落点卡片 ══════════════ */
console.log("\n【④ 收束后不停留（用户报告：每次回答完就停住了）】");
{
  check("存在回响模块", /export async function generateEcho/.test(echo));
  check("回响按情绪自适应（resolveTone）", /function resolveTone/.test(echo));
  check("回响识别失落受挫", /失落受挫/.test(echo));
  check("回响识别紧张/迷茫", /紧张不安/.test(echo) && /迷茫/.test(echo));
  check("回响识别渴望改变（认可+点代价）", /渴望改变/.test(echo));
  check("回响识别期待希望（推一把）", /期待希望/.test(echo));
  check("回响以开放问题结尾", /开放的问题/.test(echo));
  check("回响失败可降级（不影响主流程）", /catch\s*\{[\s\S]{0,80}return null/.test(echo));

  check("supervisor 在 close_reading 后调用 generateEcho",
    /await generateEcho\(config, session, answer\)/.test(supervisor));
  check("回响作为正文流出（delta）", /chunkDelta\(echo\)/.test(supervisor));
  check("回响在 done 之前生成", /generateEcho[\s\S]{0,3000}type: "done"/.test(supervisor));
  check("回响并入 session.reading（落库/分享卡/刷新后都要有）",
    /session\.reading = session\.reading \? `\$\{session\.reading\}\\n\\n\$\{echo\}` : echo/.test(supervisor),
    "否则回响只在 SSE 里，刷新/分享卡/落库都会丢");

  // ⚠️⚠️ 2026-11-04 实测踩到的更深一层：
  //   buildFinalReading 原本在有逐张解读时**直接返回 parts，丢弃 session.reading**
  //   → 即使回响并进了 session.reading，落库正文仍然没有它。
  //   → 这条断言守住"两者互补，不丢一个"。
  check("buildFinalReading 追加 session.reading（不丢弃对话流内容）",
    /const spoken = \(session\.reading \?\? ""\)\.trim\(\)/.test(helpers),
    "逐张解读 + 对话流内容（综合/追问/回响）都要在");
  check("buildFinalReading 不再直接 return parts.join（丢弃 spoken）",
    !/return parts\.join\("\\n\\n"\);\s*\}\s*\n/.test(helpers) ||
    /if \(spoken\) parts\.push\(spoken\)/.test(helpers),
    "");

  check("存在落点卡片组件", /export default function ClosingPanel/.test(closing));
  check("落点卡片有「我想再问一句」", /我想再问一句/.test(closing));
  check("落点卡片有「保存解读卡片」", /保存解读卡片/.test(closing));
  check("落点卡片有「重新开始」", /重新开始/.test(closing));
  check("落点卡片尊重 canFollowup（不给必然失败的按钮）",
    /canFollowup/.test(closing) && /disabled=\{!canFollowup\}/.test(closing));
  check("页面渲染了落点卡片", /<ClosingPanel/.test(page));
}

/* ══════════════ ⑤ 思考气泡 ══════════════ */
console.log("\n【⑤ 模型思考时的动画（用户报告：别让用户感觉等太久）】");
{
  check("存在思考气泡组件", /export default function ThinkingBubble/.test(thinking));
  check("思考气泡有三点呼吸动画", /repeat: Infinity/.test(thinking));
  check("思考气泡延迟 1.2s 出现（避免闪烁）", /elapsed >= 1\.2/.test(thinking));
  check("思考气泡按阶段换短句", /PHASE_KEY/.test(thinking));
  check("DialogueFlow 渲染了思考气泡", /<ThinkingBubble/.test(dialogue));
  check("已开口时改用 typing-cursor（不重复显示）", /tellerStarted/.test(dialogue));
  check("页面传了思考气泡的三个输入",
    /thinkingPhase=\{phase\}/.test(page) &&
    /thinkingElapsed=\{thinkingElapsed\}/.test(page) &&
    /thinkingRound=\{rounds\.length\}/.test(page));
}

/* ══════════════ ⑥ 翻牌可点性 ══════════════ */
console.log("\n【⑥ 牌出现但点不动（用户报告：有时候点的无效）】");
{
  check("flip 事件提前把牌置为可点（消除 300ms 空窗）",
    /p\.ask\?\.kind === "flip"[\s\S]{0,600}current: i === target/.test(page));
  check("点击有乐观反馈（flipping 态）",
    /flipping: true/.test(page));
  check("失败时撤销乐观更新",
    /flipping \? \{ \.\.\.c, flipping: false \}/.test(page));
  check("409 不再静默（给可见轻提示）", /setHint\("占卜师还在准备这张牌/.test(page));
  check("存在轻提示 state（区别于 error 横幅）", /const \[hint, setHint\]/.test(frontCode));
  check("轻提示会自动消失", /setHint\(""\)/.test(page) && /clearTimeout/.test(page));

  check("不可点的牌有「等待中」文案", /等待中/.test(cardSpread));
  check("不可点的牌用 cursor-wait", /cursor-wait/.test(cardSpread));
  check("可点的牌有强呼吸光", /c\.current[\s\S]{0,400}boxShadow/.test(cardSpread));
  check("翻牌中禁止重复点击", /pointer-events-none/.test(cardSpread));

  check("修掉了重复 POST 的 bug（失败分支不再重发）",
    !/status !== 200\)[\s\S]{0,400}await fetch\("\/api\/answer"/.test(page));
  check("post 同时返回状态码与错误体", /Promise<\{ status: number; err:/.test(page));
}

/* ══════════════ ⑦ 后端时序未被破坏 ══════════════ */
console.log("\n【⑦ HITL 闸门时序（不能为了 UX 破坏协议）】");
{
  check("waitUserAnswer 仍先于事件发出（防 409 抢跑）",
    /waitUserAnswer[\s\S]{0,300}type: "ask_user"/.test(supervisor) ||
    /const flipWait = waitUserAnswer[\s\S]{0,600}card_flip_ready/.test(supervisor));
  check("HITL 仍是唯一阻塞点", /export function waitUserAnswer/.test(hitl));
  check("pendingAsk 同步设置（协议不变）", /session\.pendingAsk = \{ resolve: finish/.test(hitl));
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 2);
