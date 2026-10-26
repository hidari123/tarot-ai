/**
 * 岔路口兜底逻辑自检（模型漏传 branches 时不能死锁）
 * 运行：node scripts/test-crossroads-fallback.cjs
 */

// 与 src/lib/tarot-agent.ts 的 extractBranchesFromPrompt 保持一致（改算法时同步两处）
function extractBranchesFromPrompt(prompt) {
  const branches = [];

  // ① 编号项
  //    两步走：① 单独匹配"编号标记"（不含前置条件，避免吃掉分隔符）
  //            ② 按标记位置切分文本，逐段清洗
  //    两种标记形态：
  //      A. 数字/中文数字/字母 + 分隔符（1. / 一、 / A.）
  //      B. 圆圈数字（自带分隔符，后面直接跟内容：①继续坚持）
  const marker = /[（(]?\s*((?:[0-9]{1,2}|[一二三四五六七八九十]|[A-Ha-h])[）).、．:：]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/g;
  const marks = [];
  let m;
  while ((m = marker.exec(prompt)) !== null) {
    // 排除"1.5"这类小数、"2024年"这类年份：标记前不能是数字
    const before = prompt[m.index - 1] ?? "";
    if (/[0-9]/.test(before) && /^[0-9]/.test(m[1])) continue;
    marks.push({ start: m.index, end: marker.lastIndex });
  }
  if (marks.length >= 2) {
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].end;
      const end = i + 1 < marks.length ? marks[i + 1].start : prompt.length;
      const body = prompt.slice(start, end).replace(/[；;。\n、，]+$/, "").trim();
      if (body.length >= 2 && body.length <= 60) branches.push(body);
    }
    if (branches.length >= 2) return branches.slice(0, 4);
  }

  // ② 引号并列：「xxx」「xxx」
  const quoted = prompt.match(/[「『【]([^」』】]{2,50})[」』】]/g);
  if (quoted) {
    const cleaned = quoted.map((q) => q.replace(/^[「『【]|[」』】]$/g, "").trim()).filter((q) => q.length >= 2);
    if (cleaned.length >= 2) return cleaned.slice(0, 4);
  }

  // ③ 或字并列
  const alt = prompt.split(/[，,]\s*(?:或者|还是|或是|或)\s*/);
  if (alt.length >= 2) {
    const parts = alt.map((s) => s.trim()).filter((s) => s.length >= 3 && s.length <= 60);
    if (parts.length >= 2) return parts.slice(0, 4);
  }

  return branches;
}

let fail = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
}

console.log("== 1. 阿拉伯数字编号 ==");
const r1 = extractBranchesFromPrompt("你打算怎么走？1. 稳妥路线 2. 冒险路线 3. 观望");
check("抠出 3 条", r1.length === 3, JSON.stringify(r1));

console.log("\n== 2. 圆圈数字 ==");
const r2 = extractBranchesFromPrompt("接下来①继续坚持 ②及时止损 ③另寻他路");
check("抠出 3 条", r2.length === 3, JSON.stringify(r2));

console.log("\n== 3. 中文数字 ==");
const r3 = extractBranchesFromPrompt("三条路：一、稳妥 二、冒险 三、观望");
check("抠出 3 条", r3.length === 3, JSON.stringify(r3));

console.log("\n== 4. 字母编号 ==");
const r4 = extractBranchesFromPrompt("A. 留下 B. 离开 C. 转型");
check("抠出 3 条", r4.length === 3, JSON.stringify(r4));

console.log("\n== 5. 引号并列 ==");
const r5 = extractBranchesFromPrompt("你可以选择「留在原公司」或者「去新平台」，也可以「自己单干」");
check("抠出 >=2 条", r5.length >= 2, JSON.stringify(r5));

console.log("\n== 6. 或字并列 ==");
const r6 = extractBranchesFromPrompt("你可以继续投简历，或者直接找内推");
check("抠出 >=2 条", r6.length >= 2, JSON.stringify(r6));

console.log("\n== 7. 无结构的纯叙述（返回空 → 上层通用选项兜底）==");
const r7 = extractBranchesFromPrompt("命运走到了岔路口，技术岗这条路，你打算怎么走？");
check("返回空数组", r7.length === 0, JSON.stringify(r7));

console.log(fail === 0 ? "\n✅ 全部通过" : `\n❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
