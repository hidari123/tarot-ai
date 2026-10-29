#!/usr/bin/env node
/**
 * 验证前端牌阵面板的渲染与防剧透（DOM 层面）：
 *  1. 选牌后对话流里出现"你的命运之牌"面板
 *  2. 翻牌前：牌阵面板里**没有**牌名（只有 ?）
 *  3. 翻牌后：牌名出现
 *  4. 顶部时间线与对话流牌阵同步
 *
 * 用法：node scripts/verify-flip-frontend.mjs [baseUrl]
 * 说明：这是静态检查（检查 SSR/CSR 结构），不驱动浏览器。
 */
const BASE = process.argv[2] || "http://localhost:3000";

// 1. 首页可达
const home = await fetch(BASE);
console.log(`首页: ${home.status} ${home.ok ? "✅" : "❌"}`);

// 2. 组件源码级检查：确保 CardSpread/DialogueFlow 的关键结构存在
const fs = await import("node:fs");
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const spread = read("src/components/CardSpread.tsx");
const flow = read("src/components/DialogueFlow.tsx");
const modal = read("src/components/CardPreviewModal.tsx");

const checks = [
  ["CardSpread 有 flipped 状态", /flipped:\s*boolean/.test(spread)],
  ["CardSpread 有 current 状态", /current:\s*boolean/.test(spread)],
  ["CardSpread 未翻开显示 ?", /text-purple-400\/30">？/.test(spread)],
  ["CardSpread 牌面用 flipped 判断", /c\.flipped\s*\?\s*\(/s.test(spread)],
  ["CardSpread 点击已翻开→预览", /c\.flipped\) onPreview/.test(spread)],
  ["CardSpread 点击当前→翻牌", /c\.current\) onFlipCard/.test(spread)],
  ["CardSpread 无翻转 toggle", !/onFlip.*toggle|rotateY.*onClick.*flipped/s.test(spread)],
  ["DialogueFlow 有 spread 条目类型", /case "spread":/.test(flow)],
  ["DialogueFlow 有 SpreadPanel", /SpreadPanel/.test(flow)],
  ["DialogueFlow 牌阵面板渲染牌背", /点我翻开/.test(flow)],
  ["DialogueFlow flip 面板存在", /isFlip/.test(flow)],
  ["DialogueFlow 无 continue 分支", !/isContinue/.test(flow)],
  // ⚠️ "翻下一张" 按钮已移除，但注释里会提到它 —— 只查 JSX 里的按钮
  ["DialogueFlow CardBlock 无翻下一张按钮", !/>\s*翻下一张\s*→\s*</.test(flow)],
  ["Modal 支持 Esc 关闭", /Escape/.test(modal)],
  ["Modal 显示牌名", /nameZh/.test(modal)],
  ["Modal 有放大预览语义", /cursor-zoom-in|cursor-pointer/.test(spread + flow)],
];

console.log("\n=== 前端结构检查 ===");
let pass = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);

// 3. 后端事件不含牌面
const agent = read("src/lib/tarot-agent.ts");
const flipReadyCheck =
  /cardFlipReady:\s*\{\s*cardIndex:\s*idx,\s*total:[^}]*pos\s*\}/s.test(agent);
console.log(`\n后端 cardFlipReady 只含索引/位置: ${flipReadyCheck ? "✅" : "❌"}`);
// ⚠️ 闸门等待必须被 await（否则后端不等用户就往下跑）。
//    2026-10 改造：为了修"前端抢跑 409"，把
//      await waitUserAnswer(session, flipPrompt, ...)
//    改成
//      const flipWait = waitUserAnswer(session, flipPrompt, ...);  // 同步设 pendingAsk
//      yield { card_flip_ready };                                   // 再通知前端可点
//      const flipResult = await flipWait;                          // 仍然是 await
//    两种写法都要认（语义相同：闸门一定被等待）。
const gateCheck =
  /card_flip_ready/.test(agent) &&
  (/await waitUserAnswer\(session, flipPrompt/.test(agent) ||
    /const flipWait = waitUserAnswer\(session, flipPrompt[\s\S]*?await flipWait/.test(agent));
console.log(`后端翻牌闸门 await: ${gateCheck ? "✅" : "❌"}`);

process.exit(pass === checks.length && flipReadyCheck && gateCheck ? 0 : 2);
