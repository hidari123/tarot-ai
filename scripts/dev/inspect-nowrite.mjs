import Database from "better-sqlite3";
const db = new Database("data/tarot.db");
const q = (sql, ...a) => db.prepare(sql).all(...a);

const done = q("SELECT id, question, cards_json, reading, review_json, created_at, finished_at FROM sessions WHERE status='done'");
const noWrite = [];
for (const s of done) {
  const c = db.prepare("SELECT COUNT(*) n FROM tool_calls WHERE session_id=? AND tool='write_reading'").get(s.id);
  if (c.n === 0) noWrite.push(s);
}
console.log(`=== done 但没走 write_reading 的会话：${noWrite.length} 场 ===\n`);

for (const s of noWrite.slice(0, 6)) {
  const readingLen = (s.reading || "").length;
  let cards = 0;
  try { cards = JSON.parse(s.cards_json || "[]").filter((x) => x && (x.nameZh || x.id)).length; } catch {}
  const dur = s.finished_at && s.created_at ? ((s.finished_at - s.created_at) / 1000).toFixed(0) : "?";
  console.log(`--- ${s.id} ---`);
  console.log(`  问题: ${(s.question || "").slice(0, 40)}`);
  console.log(`  牌数: ${cards} · 解读长度: ${readingLen} · 审校: ${s.review_json ? (s.review_json.includes("审校解析失败") ? "解析失败" : "有") : "NULL"} · 耗时: ${dur}s`);
  const tools = q(`SELECT tool, result_summary FROM tool_calls WHERE session_id=? ORDER BY id`, s.id);
  console.log(`  工具链: ${tools.map((t) => t.tool).join(" → ")}`);
  const last = tools[tools.length - 1];
  if (last) console.log(`  最后一个工具: ${last.tool} — ${String(last.result_summary || "").slice(0, 60)}`);
  console.log("");
}

// 统计这批会话的共同特征
const withCards = noWrite.filter((s) => { try { return JSON.parse(s.cards_json || "[]").length > 0; } catch { return false; } }).length;
const withReading = noWrite.filter((s) => (s.reading || "").length > 50).length;
console.log(`=== 特征统计 ===`);
console.log(`  有牌面: ${withCards} / ${noWrite.length}`);
console.log(`  有解读正文(>50字): ${withReading} / ${noWrite.length}`);
console.log(`  两者都无: ${noWrite.length - withCards} 场（空会话被标记为 done）`);
