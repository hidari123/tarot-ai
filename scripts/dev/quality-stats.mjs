import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log("=== ① 审校结果分布（sessions.review_json）===");
const rows = q("SELECT review_json FROM sessions WHERE review_json IS NOT NULL AND review_json != ''");
const stat = { pass: 0, fail: 0, unknown: 0, truncated: 0, dims: {} };
for (const r of rows) {
  try {
    const rv = JSON.parse(r.review_json);
    const pass = rv.pass ?? rv.overallPass;
    // ⚠️ P3-⑩：正文被截断的会话**单独计数，不计入通过率分母**
    //   原因：reviewer 看到的是半截正文，评分不能代表完整解读的质量。
    //   把它们混进通过率 → 指标失真（假绿灯）。
    //   这也修正了此前"通过率 61.2%"这个数字的口径。
    if (rv.truncated === true) {
      stat.truncated++;
      continue;
    }
    if (pass === true) stat.pass++;
    else if (pass === false) stat.fail++;
    else stat.unknown++;
    for (const d of ["grounding", "empathy", "tone"]) {
      const v = rv[d] ?? rv.scores?.[d];
      if (typeof v === "number") {
        stat.dims[d] = stat.dims[d] ?? { sum: 0, n: 0, min: 10, max: 0 };
        stat.dims[d].sum += v;
        stat.dims[d].n++;
        stat.dims[d].min = Math.min(stat.dims[d].min, v);
        stat.dims[d].max = Math.max(stat.dims[d].max, v);
      }
    }
  } catch { stat.unknown++; }
}
const rated = stat.pass + stat.fail;
console.log(`  样本 ${rows.length} · 通过 ${stat.pass} · 未通过 ${stat.fail} · 解析失败 ${stat.unknown} · 截断不计 ${stat.truncated}`);
console.log(`  ① 严格口径（只算完整审校）: ${((stat.pass / Math.max(1, rated)) * 100).toFixed(1)}%（分母 ${rated} = 通过 ${stat.pass} + 未通过 ${stat.fail}）`);
// ⚠️ 宽松口径：把"解析失败"算作未通过
//   （这是**改造前**的口径，保留以便与历史数字对比）
const loose = (stat.pass / Math.max(1, rows.length - stat.truncated)) * 100;
console.log(`  ② 宽松口径（解析失败算未通过）: ${loose.toFixed(1)}%（分母 ${rows.length - stat.truncated}）`);
console.log(`  ⚠️ 两个口径的差 = 解析失败的 ${stat.unknown} 场 —— 它们**根本没被审校**`);
if (stat.truncated > 0) {
  console.log(`  ⚠️ 有 ${stat.truncated} 场正文被截断（流中断），已从两个口径中剔除 —— 此前它们会被算作"通过"`);
}
for (const [d, s] of Object.entries(stat.dims)) {
  console.log(`  ${d.padEnd(10)} 均值 ${(s.sum / s.n).toFixed(2)} · 最低 ${s.min} · 最高 ${s.max} · n=${s.n}`);
}

console.log("\n=== ② 有多少场占卜触发了 Reflexion 重写（审校不过 → 重写）===");
const rewrites = q(`SELECT COUNT(*) n FROM llm_usage WHERE agent='writer'`);
console.log(`  writer 调用 ${rewrites[0].n} 次（每场至少 1 次；多出来的即重写）`);
const w = q(`SELECT session_id, COUNT(*) n FROM llm_usage WHERE agent='writer' GROUP BY session_id`);
const multi = w.filter((x) => x.n > 1);
console.log(`  发生过重写的会话: ${multi.length} / ${w.length} = ${((multi.length / Math.max(1, w.length)) * 100).toFixed(1)}%`);

console.log("\n=== ③ 失败会话的分布（看是不是被 max_rounds 截断）===");
// ⚠️ 原来这里查 `sessions.rounds` —— **该列不存在**（脚本从加 rounds 统计后就没再更新 schema）
//    → 脚本每次跑到这里就抛 SqliteError。
//    改用**实际可用**的代理指标：tool_calls 数（每场约 14 次工具调用 ≈ 轮次量级）。
const failRows = q(`SELECT error_reason, COUNT(*) n FROM sessions
  WHERE error_reason IS NOT NULL AND error_reason != '' GROUP BY error_reason`);
for (const r of failRows) {
  // ⚠️ 用 JOIN 统计平均工具调用数（而不是不存在的 rounds 列）
  const avgCalls = q(`SELECT AVG(c) avg FROM (
    SELECT COUNT(*) c FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    WHERE s.error_reason = ? GROUP BY tc.session_id
  )`, r.error_reason);
  console.log(`  ${String(r.error_reason).padEnd(20)} ${String(r.n).padStart(3)} 场 · 平均工具调用 ${(avgCalls[0]?.avg ?? 0).toFixed(1)} 次`);
}

console.log("\n=== ④ 各终态会话数与平均工具调用 ===");
for (const r of q(`SELECT status, COUNT(*) n FROM sessions GROUP BY status`)) {
  const avgCalls = q(`SELECT AVG(c) avg FROM (
    SELECT COUNT(*) c FROM tool_calls tc
    JOIN sessions s ON s.id = tc.session_id
    WHERE s.status = ? GROUP BY tc.session_id
  )`, r.status);
  console.log(`  ${r.status.padEnd(8)} ${String(r.n).padStart(3)} 场 · 平均 ${(avgCalls[0]?.avg ?? 0).toFixed(1)} 次工具调用`);
}

console.log("\n=== ⑤ 卡片解读完整度（每场是否讲完 3 张）===");
// ⚠️ 原来查 `sessions.card_readings_json` —— **该列不存在**。
//    逐张解读实际存在 **state_json** 快照里（字段名 cardReadings）。
const c = q(`SELECT id, cards_json, state_json FROM sessions WHERE status='done' LIMIT 500`);
let full = 0, partial = 0, none = 0, noSnapshot = 0;
for (const r of c) {
  try {
    const cards = JSON.parse(r.cards_json || "[]");
    // ⚠️ state_json 可能为空（早期会话没落快照）→ 这种情况无法判断完整度
    if (!r.state_json) { noSnapshot++; continue; }
    const snap = JSON.parse(r.state_json);
    const readings = Array.isArray(snap.cardReadings) ? snap.cardReadings : [];
    const n = cards.filter((x) => x && (x.nameZh || x.id)).length;
    const done = readings.filter((x) => x && x.reading).length;
    if (n > 0 && done >= n) full++;
    else if (done > 0) partial++;
    else none++;
  } catch { none++; }
}
console.log(`  全部讲完 ${full} · 部分 ${partial} · 没有解读 ${none} · 无快照（无法判断）${noSnapshot}（共 ${c.length} 场）`);
