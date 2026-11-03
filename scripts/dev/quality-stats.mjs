import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

console.log("=== ① 审校结果分布（sessions.review_json）===");
const rows = q("SELECT review_json FROM sessions WHERE review_json IS NOT NULL AND review_json != ''");
const stat = { pass: 0, fail: 0, unknown: 0, dims: {} };
for (const r of rows) {
  try {
    const rv = JSON.parse(r.review_json);
    const pass = rv.pass ?? rv.overallPass;
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
console.log(`  样本 ${rows.length} · 通过 ${stat.pass} · 未通过 ${stat.fail} · 解析失败 ${stat.unknown}`);
console.log(`  通过率 ${((stat.pass / Math.max(1, rows.length)) * 100).toFixed(1)}%`);
for (const [d, s] of Object.entries(stat.dims)) {
  console.log(`  ${d.padEnd(10)} 均值 ${(s.sum / s.n).toFixed(2)} · 最低 ${s.min} · 最高 ${s.max} · n=${s.n}`);
}

console.log("\n=== ② 有多少场占卜触发了 Reflexion 重写（审校不过 → 重写）===");
const rewrites = q(`SELECT COUNT(*) n FROM llm_usage WHERE agent='writer'`);
console.log(`  writer 调用 ${rewrites[0].n} 次（每场至少 1 次；多出来的即重写）`);
const w = q(`SELECT session_id, COUNT(*) n FROM llm_usage WHERE agent='writer' GROUP BY session_id`);
const multi = w.filter((x) => x.n > 1);
console.log(`  发生过重写的会话: ${multi.length} / ${w.length} = ${((multi.length / Math.max(1, w.length)) * 100).toFixed(1)}%`);

console.log("\n=== ③ 失败会话的轮次分布（看是不是被 max_rounds 截断）===");
for (const r of q(`SELECT error_reason, COUNT(*) n, AVG(rounds) avg_rounds FROM sessions
  WHERE error_reason IS NOT NULL AND error_reason != '' GROUP BY error_reason`)) {
  console.log(`  ${String(r.error_reason).padEnd(20)} ${String(r.n).padStart(3)} 场 · 平均轮次 ${(r.avg_rounds ?? 0).toFixed(1)}`);
}

console.log("\n=== ④ done 会话的平均轮次与 token ===");
for (const r of q(`SELECT status, COUNT(*) n, ROUND(AVG(rounds)) avg_rounds FROM sessions GROUP BY status`)) {
  console.log(`  ${r.status.padEnd(8)} ${String(r.n).padStart(3)} 场 · 平均 ${r.avg_rounds} 轮`);
}

console.log("\n=== ⑤ 卡片解读完整度（每场是否讲完 3 张）===");
const c = q(`SELECT id, cards_json, card_readings_json FROM sessions WHERE status='done' LIMIT 500`);
let full = 0, partial = 0, none = 0;
for (const r of c) {
  try {
    const cards = JSON.parse(r.cards_json || "[]");
    const readings = JSON.parse(r.card_readings_json || "[]");
    const n = cards.filter((x) => x && (x.nameZh || x.id)).length;
    const done = readings.filter((x) => x && x.reading).length;
    if (n > 0 && done >= n) full++;
    else if (done > 0) partial++;
    else none++;
  } catch { none++; }
}
console.log(`  全部讲完 ${full} · 部分 ${partial} · 没有解读 ${none}（共 ${c.length} 场）`);
